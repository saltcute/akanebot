import type { Rng } from "../lib/rng.ts";
import type { Persona } from "../persona/schema.ts";
import type { GateFeatures } from "./features.ts";

export type SpeakDecision = { speak: boolean; probability: number; addressed: boolean };
export type RepeatDecision = { repeat: boolean; probability: number };

/** The state of the body, the relationship and the question at the moment of deciding. */
export type SpeakContext = {
    /** From 1 (rested) to 0 (done talking for today). */
    battery: number;
    joinFactor: number;
    /** From -1 (can't stand them) to 1 (favourite). */
    affinity: number;
    /** How long ago the newest message was sent. */
    staleMs: number;
    /** The person already got ignored once and is asking again. */
    forceAnswer: boolean;
    /** The question is technical and beyond the persona's skills. */
    outOfDepth: boolean;
};

export const NEUTRAL_CONTEXT: SpeakContext = { battery: 1, joinFactor: 1, affinity: 0, staleMs: 0, forceAnswer: false, outOfDepth: false };

const ALREADY_ANSWERED_FACTOR = 0.4;
const UNCLEAR_ADDRESS_FACTOR = 1.5;
const LOW_BATTERY = 0.3;
const EMPTY_BATTERY_ANSWER_FACTOR = 0.3;
const STALE_JOIN_MS = 20 * 60_000;
const STALE_ASK_MS = 12 * 3_600_000;
const STALE_FACTOR = 0.3;

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/** LLMs are poor at deciding whether to speak, so the model reports features and this rolls the dice. */
export function decideToSpeak(
    features: GateFeatures,
    persona: Persona,
    mentioned: boolean,
    rng: Rng,
    context: SpeakContext = NEUTRAL_CONTEXT,
): SpeakDecision {
    const addressed = mentioned || features.addressedToMe === "yes";
    const probability = addressed ? answerProbability(persona, context) : joinProbability(features, persona, context);
    return { speak: rng.chance(probability), probability, addressed };
}

/** Joining a chain needs no interest in the topic, but it still takes being around and having the energy. */
export function decideToRepeat(features: GateFeatures, persona: Persona, rng: Rng, context: SpeakContext = NEUTRAL_CONTEXT): RepeatDecision {
    const probability = features.safeToRepeat && !features.highStakes ? repeatProbability(persona, context) : 0;
    return { repeat: rng.chance(probability), probability };
}

function repeatProbability(persona: Persona, context: SpeakContext): number {
    if (context.staleMs > STALE_JOIN_MS) return 0;
    let probability = persona.repeatRate * context.joinFactor;
    if (context.battery < LOW_BATTERY) probability *= context.battery / LOW_BATTERY;
    return clamp(probability);
}

function answerProbability(persona: Persona, context: SpeakContext): number {
    if (context.forceAnswer) return 1;
    // People get answered more readily by friends. Someone who's annoyed it gets left on read more.
    let probability = 1 - clamp(persona.ignoreDirectAsks * (1 - 0.7 * context.affinity));
    if (context.battery <= 0) probability *= EMPTY_BATTERY_ANSWER_FACTOR;
    if (context.staleMs > STALE_ASK_MS) probability *= STALE_FACTOR;
    return clamp(probability);
}

function joinProbability(features: GateFeatures, persona: Persona, context: SpeakContext): number {
    // Nobody asked, so a person who can't follow the conversation just stays out of it.
    if (!features.canFollow || context.outOfDepth) return 0;
    const interest = clamp(features.interest);
    let probability = persona.talkativeness * (0.25 + 1.5 * interest) * context.joinFactor;
    if (features.someoneAlreadyAnswered) probability *= ALREADY_ANSWERED_FACTOR;
    if (features.addressedToMe === "unclear") probability *= UNCLEAR_ADDRESS_FACTOR;
    if (context.battery < LOW_BATTERY) probability *= context.battery / LOW_BATTERY;
    if (context.staleMs > STALE_JOIN_MS) probability *= STALE_FACTOR;
    return clamp(probability);
}

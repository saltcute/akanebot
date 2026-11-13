import type { ChatMessage } from "../adapters/types.ts";
import type { Rng } from "../lib/rng.ts";
import { isAddressed } from "../perception/channel.ts";
import type { Persona } from "../persona/schema.ts";
import { OWN_REACTION_PREFIX } from "../reply/prompt.ts";
import type { GateFeatures } from "./features.ts";

export type SpeakDecision = { speak: boolean; probability: number; addressed: boolean; followUp: boolean; possibleFollowUp: boolean };
/** A line that came straight after one of hers. `sure` is false when it may well be meant for the room or for someone else. */
export type FollowUp = { message: ChatMessage; sure: boolean };
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
    /** Every new message is meant for someone else. */
    aimedElsewhere: boolean;
    /** A new message calls the persona by name, which a person notices without being @-mentioned. */
    named: boolean;
    /** Someone is answering what the persona just said, without quoting it or @-mentioning her. */
    followUp: boolean;
    /** A line came straight after hers, but it's a toss-up whether it was for her. */
    possibleFollowUp: boolean;
};

export const NEUTRAL_CONTEXT: SpeakContext = {
    battery: 1,
    joinFactor: 1,
    affinity: 0,
    staleMs: 0,
    forceAnswer: false,
    outOfDepth: false,
    aimedElsewhere: false,
    named: false,
    followUp: false,
    possibleFollowUp: false,
};

const ALREADY_ANSWERED_FACTOR = 0.4;
const LOW_BATTERY = 0.3;
const EMPTY_BATTERY_ANSWER_FACTOR = 0.3;
const STALE_JOIN_MS = 20 * 60_000;
const STALE_ASK_MS = 12 * 3_600_000;
const STALE_FACTOR = 0.3;
/** A reply to her that nobody quoted is usually answered, but less surely than a direct question, so banter can peter out. */
const FOLLOW_UP_FACTOR = 0.7;
/** A line that only might be for her gets a much smaller chance, and she joins in rather than answers. */
const POSSIBLE_FOLLOW_UP_FACTOR = 0.28;
const FOLLOW_UP_MS = 2 * 60_000;
/** How far back someone must have spoken to count as part of the conversation she was in. */
const IN_CONVERSATION_LINES = 10;
/** One-character aliases are parts of other words too often, as 茜 is in 小顺茜, to count as being named. */
const MIN_NAME_LENGTH = 2;

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function withoutMentions(message: ChatMessage): string {
    return (message.mentions ?? []).reduce((text, name) => text.replaceAll(`@${name}`, " "), message.text).toLowerCase();
}

/** Only text outside the @-mentions counts, so a member called 茜茜 doesn't pass for the alias 茜. QQ adds an @ to replies, so being named still wins. */
function aimedAtSomeoneElse(message: ChatMessage, persona: Persona): boolean {
    if (!message.mentions?.length || isAddressed(message)) return false;
    const rest = withoutMentions(message);
    return ![persona.name, ...persona.aliases].some((name) => rest.includes(name.toLowerCase()));
}

/** The gate model misses "小茜你看这是什么" often enough that code checks for her name itself. */
export function findNamer(newMessages: readonly ChatMessage[], persona: Persona): ChatMessage | undefined {
    const names = [persona.name, ...persona.aliases].filter((name) => [...name].length >= MIN_NAME_LENGTH).map((name) => name.toLowerCase());
    return newMessages.findLast((message) => !message.sender.isBot && names.some((name) => withoutMentions(message).includes(name)));
}

function isForSomeoneElse(message: ChatMessage, persona: Persona): boolean {
    return aimedAtSomeoneElse(message, persona) || (message.replyTo !== undefined && !message.repliesToSelf);
}

/** Pictures, stickers, QQ faces and shared links are all placeholders in the text. Without anything typed beside them, there's nothing said. */
function hasWords(message: ChatMessage): boolean {
    return message.text.replace(/\[[^\]]*\]|(^|\s)\/\S+/g, " ").trim() !== "";
}

/** A reaction isn't a message, and a line she echoed was the chain's, not hers, so nobody is answering either. */
function canBeAnswered(window: readonly ChatMessage[], ownIndex: number): boolean {
    const own = window[ownIndex];
    if (!own || own.text.startsWith(OWN_REACTION_PREFIX)) return false;
    const previous = window.slice(0, ownIndex).findLast((message) => !message.groupEvent);
    return previous?.text.trim() !== own.text.trim();
}

/**
 * The person she was answering is still talking to her, whatever they send. Anyone else has to say something, be part of
 * the conversation already, and not be passing a line around or carrying on with someone they just @-mentioned.
 */
function isSurelyForHer(window: readonly ChatMessage[], index: number, ownIndex: number, persona: Persona): boolean {
    const message = window[index];
    if (!message) return false;
    const spoken = (line: ChatMessage) => !line.groupEvent;
    const earlier = window.slice(0, ownIndex).filter(spoken);
    if (earlier.findLast((line) => !line.isSelf)?.sender.id === message.sender.id) return true;
    if (!hasWords(message)) return false;
    const previous = window.slice(0, index).findLast(spoken);
    if (previous && !previous.isSelf && previous.sender.id === message.sender.id && isForSomeoneElse(previous, persona)) return false;
    const recent = earlier.slice(-IN_CONVERSATION_LINES).filter((line) => !line.isSelf);
    const saidByAnother = (line: ChatMessage | undefined) =>
        line !== undefined && !line.isSelf && line.sender.id !== message.sender.id && line.text.trim() === message.text.trim();
    if (recent.some(saidByAnother) || saidByAnother(window.slice(index + 1).find(spoken))) return false;
    return recent.some((line) => line.sender.id === message.sender.id);
}

/**
 * A new line that comes straight after one of hers, from someone not talking to anyone else, is usually an answer to it.
 * The gate model reads "嘿嘿" or "不对吧" as undirected, so code settles it from who spoke last. A sure one anywhere in the
 * new lines beats a newer one that's only possible.
 */
export function findFollowUp(window: readonly ChatMessage[], firstNewIndex: number, persona: Persona): FollowUp | undefined {
    let possible: FollowUp | undefined;
    for (let index = window.length - 1; index >= firstNewIndex; index--) {
        const message = window[index];
        if (!message || message.isSelf || message.sender.isBot || message.groupEvent) continue;
        if (isForSomeoneElse(message, persona)) continue;
        const beforeIndex = window.findLastIndex(
            (earlier, at) => at < index && !earlier.groupEvent && (earlier.isSelf || earlier.sender.id !== message.sender.id),
        );
        const before = window[beforeIndex];
        if (!before?.isSelf || !canBeAnswered(window, beforeIndex) || message.sentAt - before.sentAt > FOLLOW_UP_MS) continue;
        // Saying her line back is carrying on a chain she joined, not answering her.
        if (message.text.trim() === before.text.trim()) continue;
        if (isSurelyForHer(window, index, beforeIndex, persona)) return { message, sure: true };
        possible ??= { message, sure: false };
    }
    return possible;
}

export function allAimedElsewhere(newMessages: readonly ChatMessage[], persona: Persona): boolean {
    return newMessages.length > 0 && newMessages.every((message) => aimedAtSomeoneElse(message, persona));
}

/** The model takes "you" after someone else's @ to mean the persona. The platform says who it's for, so code settles it. */
export function overruleMisaddress(features: GateFeatures, newMessages: readonly ChatMessage[], persona: Persona): GateFeatures {
    if (features.addressedToMe === "no" || !allAimedElsewhere(newMessages, persona)) return features;
    return { ...features, addressedToMe: "no", towardMe: "neutral" };
}

/** LLMs are poor at deciding whether to speak, so the model reports features and this rolls the dice. */
export function decideToSpeak(
    features: GateFeatures,
    persona: Persona,
    mentioned: boolean,
    rng: Rng,
    context: SpeakContext = NEUTRAL_CONTEXT,
): SpeakDecision {
    const addressed = mentioned || features.addressedToMe === "yes" || context.named;
    const followUp = !addressed && context.followUp;
    const possibleFollowUp = !addressed && !followUp && context.possibleFollowUp;
    const factor = followUp ? FOLLOW_UP_FACTOR : possibleFollowUp ? POSSIBLE_FOLLOW_UP_FACTOR : 0;
    const probability = addressed
        ? answerProbability(persona, context)
        : Math.max(factor * answerProbability(persona, { ...context, forceAnswer: false }), joinProbability(features, persona, context));
    return { speak: rng.chance(probability), probability, addressed, followUp, possibleFollowUp };
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
    // Nobody asked, so a person who can't follow the conversation, or sees it's between other people, just stays out of it.
    if (!features.canFollow || context.outOfDepth || context.aimedElsewhere) return 0;
    // Steep in interest: background chatter rarely draws her in, while something she cares about still does.
    const interest = clamp(features.interest);
    let probability = persona.talkativeness * (0.05 + 2 * interest ** 2) * context.joinFactor;
    if (features.someoneAlreadyAnswered) probability *= ALREADY_ANSWERED_FACTOR;
    if (context.battery < LOW_BATTERY) probability *= context.battery / LOW_BATTERY;
    if (context.staleMs > STALE_JOIN_MS) probability *= STALE_FACTOR;
    return clamp(probability);
}

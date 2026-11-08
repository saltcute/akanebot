import type { Rng } from "../lib/rng.ts";
import type { Persona } from "../persona/schema.ts";
import type { GateFeatures } from "./features.ts";

export type SpeakDecision = { speak: boolean; probability: number; addressed: boolean };

const ALREADY_ANSWERED_FACTOR = 0.4;
const UNCLEAR_ADDRESS_FACTOR = 1.5;

/** LLMs are poor at deciding whether to speak, so the model reports features and this rolls the dice. */
export function decideToSpeak(features: GateFeatures, persona: Persona, mentioned: boolean, rng: Rng): SpeakDecision {
    const addressed = mentioned || features.addressedToMe === "yes";
    const probability = addressed ? 1 - persona.ignoreDirectAsks : joinProbability(features, persona);
    return { speak: rng.chance(probability), probability, addressed };
}

function joinProbability(features: GateFeatures, persona: Persona): number {
    const interest = Math.min(1, Math.max(0, features.interest));
    let probability = persona.talkativeness * (0.25 + 1.5 * interest);
    if (features.someoneAlreadyAnswered) probability *= ALREADY_ANSWERED_FACTOR;
    if (features.addressedToMe === "unclear") probability *= UNCLEAR_ADDRESS_FACTOR;
    return Math.min(1, probability);
}

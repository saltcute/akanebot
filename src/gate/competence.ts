import type { Rng } from "../lib/rng.ts";
import type { Persona } from "../persona/schema.ts";
import type { GateFeatures } from "./features.ts";

export type CompetenceMode = "casual" | "knows" | "works_it_out" | "out_of_depth";

export type Competence = { mode: CompetenceMode; slip: boolean };

const UNKNOWN_SKILL = 1;

/** Code, not the model, decides how competent the persona gets to be on this question. */
export function assessCompetence(features: GateFeatures, persona: Persona, rng: Rng): Competence {
    if (!features.isTechnical) return { mode: "casual", slip: false };
    const gap = (persona.skills[features.domain] ?? UNKNOWN_SKILL) - clampDifficulty(features.difficulty);
    if (gap >= 1) return { mode: "knows", slip: false };
    if (gap < 0) return { mode: "out_of_depth", slip: false };
    return { mode: "works_it_out", slip: !features.highStakes && rng.chance(persona.slipRate) };
}

function clampDifficulty(difficulty: number): number {
    return Math.min(5, Math.max(1, Math.round(difficulty)));
}

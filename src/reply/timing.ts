import { z } from "zod";
import type { Rng } from "../lib/rng.ts";

export const pacingSchema = z.strictObject({
    readMsPerChar: z.number().min(0).default(25),
    maxReadMs: z.number().min(0).default(6000),
    thinkMs: z.tuple([z.number().min(0), z.number().min(0)]).default([800, 3500]),
    /** Extra thinking per point of question difficulty, so hard questions never get instant answers. */
    thinkMsPerDifficulty: z.number().min(0).default(2500),
    typingMsPerChar: z.number().min(0).default(170),
    maxTypingMs: z.number().min(0).default(12_000),
    betweenBurstsMs: z.tuple([z.number().min(0), z.number().min(0)]).default([300, 1500]),
});

export type Pacing = z.infer<typeof pacingSchema>;

export function readingDelay(pacing: Pacing, chars: number): number {
    return Math.min(pacing.maxReadMs, chars * pacing.readMsPerChar);
}

export function thinkingDelay(pacing: Pacing, difficulty: number, technical: boolean, rng: Rng): number {
    const base = rng.between(pacing.thinkMs[0], pacing.thinkMs[1]);
    return technical ? base + Math.max(1, difficulty) * pacing.thinkMsPerDifficulty : base;
}

export function typingDelay(pacing: Pacing, text: string, rng: Rng, isFirst: boolean): number {
    const pause = isFirst ? 0 : rng.between(pacing.betweenBurstsMs[0], pacing.betweenBurstsMs[1]);
    return pause + Math.min(pacing.maxTypingMs, text.length * pacing.typingMsPerChar);
}

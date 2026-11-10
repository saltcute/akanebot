import type { Rng } from "../lib/rng.ts";
import { cosine } from "../memory/recall.ts";
import type { SavedImage } from "../memory/store.ts";

/** She only has a handful in mind at once, which also keeps the prompt small. */
const MAX_OFFERED = 5;
const MOOD_ON_WHIM = 0.5;
const AFFINITY_ON_WHIM = 0.5;
const MOOD_ON_REQUEST = 0.5;
const AFFINITY_ON_REQUEST = 1.5;
const LOW_BATTERY = 0.3;

export type OfferedImage = SavedImage & { number: number };

/** What decides whether her pictures come to mind: her day, her energy and who she's talking to. */
export type OfferState = {
    /** Someone asked her for a picture. */
    requested: boolean;
    /** From -1 (a bad day) to 1 (a good one). */
    mood: number;
    /** From -1 (can't stand them) to 1 (favourite). */
    affinity: number;
    /** From 1 (rested) to 0 (done talking for today). */
    battery: number;
};

/**
 * How likely her saved pictures come to mind for this reply. Her day and the person bend the persona's rate without moving its ends,
 * so a rate of 0 stays never and 1 stays always while she has the energy. When asked, who's asking matters most.
 */
export function offerChance(rates: { useRate: number; requestRate: number }, { requested, mood, affinity, battery }: OfferState): number {
    const rate = requested ? rates.requestRate : rates.useRate;
    const lift = requested ? MOOD_ON_REQUEST * mood + AFFINITY_ON_REQUEST * affinity : MOOD_ON_WHIM * mood + AFFINITY_ON_WHIM * affinity;
    const energy = battery < LOW_BATTERY ? Math.max(0, battery) / LOW_BATTERY : 1;
    return Math.min(1, Math.max(0, rate)) ** Math.exp(-lift) * energy;
}

/** A wall between groups covers her pictures as it does her memories. QQ doesn't play GIF links, so one saved as a link stays off it. */
export function canUseHere(image: SavedImage, channel: string, sharing: ReadonlySet<string>): boolean {
    if (image.link !== null && channel.startsWith("qq:")) return false;
    return image.scope === channel || (sharing.has(image.scope) && sharing.has(channel));
}

/** The ones closest to what's being said, or any few when embeddings are unavailable. */
export function chooseOffers(images: readonly SavedImage[], query: Float32Array | undefined, rng: Rng): OfferedImage[] {
    const ranked = query ? rankedBySimilarity(images, query) : shuffled(images, rng);
    return ranked.slice(0, MAX_OFFERED).map((image, index) => ({ ...image, number: index + 1 }));
}

function rankedBySimilarity(images: readonly SavedImage[], query: Float32Array): SavedImage[] {
    const score = (image: SavedImage) => (image.embedding ? cosine(query, image.embedding) : -1);
    return [...images].sort((a, b) => score(b) - score(a));
}

function shuffled(images: readonly SavedImage[], rng: Rng): SavedImage[] {
    const pool = [...images];
    const result: SavedImage[] = [];
    while (pool.length > 0) result.push(...pool.splice(rng.int(0, pool.length - 1), 1));
    return result;
}

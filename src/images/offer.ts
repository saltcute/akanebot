import type { Rng } from "../lib/rng.ts";
import { cosine } from "../memory/recall.ts";
import type { SavedImage } from "../memory/store.ts";

/** She only has a handful in mind at once, which also keeps the prompt small. */
const MAX_OFFERED = 5;

export type OfferedImage = SavedImage & { number: number };

/** A wall between groups covers her pictures as it does her memories. */
export function canUseHere(image: SavedImage, channel: string, sharing: ReadonlySet<string>): boolean {
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

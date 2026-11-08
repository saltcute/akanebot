/** Seeded randomness (mulberry32), so every dice roll can be replayed in a test. */
export class Rng {
    #seed: string;
    #state: number;

    constructor(seed: number | string) {
        this.#seed = String(seed);
        this.#state = hashSeed(this.#seed);
    }

    /** A float in [0, 1). */
    next(): number {
        this.#state = (this.#state + 0x6d2b79f5) | 0;
        let t = this.#state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    chance(probability: number): boolean {
        if (probability <= 0) return false;
        if (probability >= 1) return true;
        return this.next() < probability;
    }

    between(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    /** An integer in [min, max], inclusive at both ends. */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    pick<T>(items: readonly T[]): T {
        const item = items[this.int(0, items.length - 1)];
        if (item === undefined) throw new Error("Rng.pick needs a non-empty array");
        return item;
    }

    /** An independent stream. Forking doesn't consume the parent, so adding a new consumer never shifts existing rolls. */
    fork(label: string): Rng {
        return new Rng(`${this.#seed}/${label}`);
    }
}

function hashSeed(seed: string): number {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

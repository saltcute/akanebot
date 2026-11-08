import type { MemoryStore, RelationshipRow } from "../memory/store.ts";

export type TowardMe = "friendly" | "neutral" | "hostile";
export type Relationship = { familiarity: number; affinity: number };

const DAY_MS = 86_400_000;
const AFFINITY_HALF_LIFE_DAYS = 30;
const FAMILIARITY_ADDRESSED = 0.03;
const FAMILIARITY_PRESENT = 0.005;
const FRIENDLY_GAIN = 0.03;
const HOSTILE_LOSS = 0.12;
/** Flattery has limits: nobody can become a favourite in one afternoon. Grudges have no such cap. */
const MAX_DAILY_GAIN = 0.1;

const STRANGER: Relationship = { familiarity: 0, affinity: 0 };

function dayOf(now: number): number {
    return Math.floor(now / DAY_MS);
}

function faded(row: RelationshipRow, now: number): number {
    return row.affinity * 0.5 ** ((now - row.updatedAt) / DAY_MS / AFFINITY_HALF_LIFE_DAYS);
}

export function currentRelationship(store: MemoryStore, channel: string, user: string, now: number): Relationship {
    const row = store.getRelationship(channel, user);
    return row ? { familiarity: row.familiarity, affinity: faded(row, now) } : STRANGER;
}

export function updateRelationship(store: MemoryStore, channel: string, user: string, towardMe: TowardMe, addressed: boolean, now: number): void {
    const row = store.getRelationship(channel, user);
    const today = dayOf(now);
    const gainedToday = row?.gainDay === today ? row.dayGain : 0;
    let affinity = row ? faded(row, now) : 0;
    let gain = 0;
    if (towardMe === "friendly") {
        gain = Math.min(FRIENDLY_GAIN, Math.max(0, MAX_DAILY_GAIN - gainedToday));
        affinity += gain;
    } else if (towardMe === "hostile") {
        affinity -= HOSTILE_LOSS;
    }
    store.saveRelationship({
        channel,
        userKey: user,
        familiarity: Math.min(1, (row?.familiarity ?? 0) + (addressed ? FAMILIARITY_ADDRESSED : FAMILIARITY_PRESENT)),
        affinity: Math.min(1, Math.max(-1, affinity)),
        updatedAt: now,
        gainDay: today,
        dayGain: gainedToday + gain,
    });
}

/** Undefined when there's nothing worth mentioning. */
export function describeRelationship({ familiarity, affinity }: Relationship): string | undefined {
    const parts: string[] = [];
    if (familiarity > 0.6) parts.push("you know them well");
    else if (familiarity < 0.1) parts.push("you barely know them");
    if (affinity > 0.25) parts.push("you like them");
    else if (affinity < -0.25) parts.push("they've annoyed you and you may be curt");
    return parts.length > 0 ? parts.join(", ") : undefined;
}

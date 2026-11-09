import { NO_LINKS, type People } from "../control/people.ts";
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

/** One body, so a person is the same person in every group. Each update starts from this, so the newest row always holds where they stand. */
function standingOf(store: MemoryStore, user: string, people: People): RelationshipRow | undefined {
    const rows = store.relationshipsOf(people.accountsOf(user)).sort((a, b) => b.updatedAt - a.updatedAt);
    const [newest] = rows;
    return newest && { ...newest, familiarity: Math.max(...rows.map((row) => row.familiarity)) };
}

export function currentRelationship(store: MemoryStore, user: string, now: number, people: People = NO_LINKS): Relationship {
    const row = standingOf(store, user, people);
    return row ? { familiarity: row.familiarity, affinity: faded(row, now) } : STRANGER;
}

export function updateRelationship(
    store: MemoryStore,
    channel: string,
    user: string,
    towardMe: TowardMe,
    addressed: boolean,
    now: number,
    people: People = NO_LINKS,
): void {
    const row = standingOf(store, user, people);
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

/** Undefined when there's nothing worth mentioning. `introduced` means the operator already said how she knows them. */
export function describeRelationship({ familiarity, affinity }: Relationship, introduced = false): string | undefined {
    const parts: string[] = [];
    if (familiarity > 0.6) parts.push("you know them well");
    else if (familiarity < 0.1 && !introduced) parts.push("you barely know them");
    if (affinity > 0.25) parts.push("you like them");
    else if (affinity < -0.25) parts.push("they've annoyed you and you may be curt");
    return parts.length > 0 ? parts.join(", ") : undefined;
}

import { Rng } from "../lib/rng.ts";
import type { Persona } from "../persona/schema.ts";
import { hoursAround, localTime } from "./schedule.ts";

export type DayState = {
    /** Plain-language notes for the reply prompt. Written here, never from chat. */
    notes: string[];
    /** From -1 (a bad day) to 1 (a good one). */
    mood: number;
    /** Multiplies how likely it is to join a conversation. */
    joinFactor: number;
};

const SLEEPY_WITHIN_MINUTES = 60;
const GROGGY_WITHIN_MINUTES = 60;

/** How today is going. Seeded by the date, so it's the same all day and survives restarts. */
export function dayState(persona: Persona, now: number): DayState {
    const { date, weekend } = localTime(now, persona.timezone);
    const rng = new Rng(`${persona.name}/${date}`);
    const mood = rng.between(-1, 1);
    const notes: string[] = [];
    let joinFactor = 1 + mood * 0.25;

    if (persona.dailyLife.length > 0) notes.push(`Today: ${rng.pick(persona.dailyLife)}`);
    if (mood > 0.5) notes.push("You're in a good mood today.");
    if (mood < -0.5) notes.push("You're in a bad mood today and less patient than usual.");
    if (weekend) joinFactor *= 1.15;

    const { minutesToSleep, minutesSinceWake } = hoursAround(persona, now);
    if (minutesSinceWake < GROGGY_WITHIN_MINUTES) {
        notes.push("You only just woke up and are still groggy.");
        joinFactor *= 0.6;
    } else if (minutesToSleep < SLEEPY_WITHIN_MINUTES) {
        notes.push("You're getting sleepy.");
        joinFactor *= 0.7;
    }
    return { notes, mood, joinFactor };
}

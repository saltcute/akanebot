import type { Clock } from "../lib/clock.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Persona } from "../persona/schema.ts";
import { localTime } from "./schedule.ts";

const BATTERY_KEY = "socialBattery";
/** The day rolls over in the small hours, so staying up past midnight doesn't refill anything. */
const DAY_ROLLOVER_MS = 5 * 3_600_000;
const IGNORE_MEMORY_MS = 30 * 60_000;

/** Energy for socializing, which drains through the day and refills after sleep. Persisted across restarts. */
export class Vitals {
    #clock: Clock;
    #persona: () => Persona;
    #store: MemoryStore;
    #ignoredAt = new Map<string, number>();

    constructor(options: { clock: Clock; persona: () => Persona; store: MemoryStore }) {
        this.#clock = options.clock;
        this.#persona = options.persona;
        this.#store = options.store;
    }

    /** From 1 (rested) to 0 (done talking for today). */
    battery(): number {
        return Math.max(0, 1 - this.#today().used / this.#persona().socialBattery);
    }

    spend(amount: number): void {
        const today = this.#today();
        this.#store.setMeta(BATTERY_KEY, JSON.stringify({ ...today, used: today.used + amount }));
    }

    /** An operator's correction, from 0 to 1. Today's search count stays as it is. */
    setBattery(level: number): void {
        const today = this.#today();
        this.#store.setMeta(BATTERY_KEY, JSON.stringify({ ...today, used: (1 - level) * this.#persona().socialBattery }));
    }

    searchesToday(): number {
        return this.#today().searches ?? 0;
    }

    noteSearch(): void {
        const today = this.#today();
        this.#store.setMeta(BATTERY_KEY, JSON.stringify({ ...today, searches: (today.searches ?? 0) + 1 }));
    }

    /** Whether this person's last direct question to it was left unanswered. */
    wasRecentlyIgnored(key: string): boolean {
        return (this.#ignoredAt.get(key) ?? -Infinity) + IGNORE_MEMORY_MS > this.#clock.now();
    }

    noteIgnored(key: string): void {
        this.#ignoredAt.set(key, this.#clock.now());
    }

    noteAnswered(key: string): void {
        this.#ignoredAt.delete(key);
    }

    #today(): { date: string; used: number; searches?: number } {
        const date = localTime(this.#clock.now() - DAY_ROLLOVER_MS, this.#persona().timezone).date;
        const saved = this.#store.getMeta(BATTERY_KEY);
        const parsed = saved ? (JSON.parse(saved) as { date: string; used: number; searches?: number }) : undefined;
        return parsed?.date === date ? parsed : { date, used: 0 };
    }
}

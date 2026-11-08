import type { CancelTimer, Clock } from "../lib/clock.ts";
import type { Rng } from "../lib/rng.ts";
import type { DecisionTrace } from "../lib/trace.ts";
import type { Persona } from "../persona/schema.ts";
import { busyPeriod, isAsleep } from "./schedule.ts";

const TICK_MS = 30_000;
const PHONE_CHECK_MINUTES: [number, number] = [1, 4];
const MINUTE_MS = 60_000;

/** Puts the body to sleep and in class. While busy, it glances at its phone now and then. */
export class Routine {
    #clock: Clock;
    #rng: Rng;
    #trace: DecisionTrace;
    #persona: () => Persona;
    #leave: () => void;
    #arrive: () => void;
    #present = true;
    #phoneUntil = 0;
    #nextPhoneCheck = 0;
    #cancel: CancelTimer | undefined;

    constructor(options: {
        clock: Clock;
        rng: Rng;
        trace: DecisionTrace;
        persona: () => Persona;
        leave: () => void;
        arrive: () => void;
    }) {
        this.#clock = options.clock;
        this.#rng = options.rng;
        this.#trace = options.trace;
        this.#persona = options.persona;
        this.#leave = options.leave;
        this.#arrive = options.arrive;
    }

    start(): void {
        this.#tick();
    }

    stop(): void {
        this.#cancel?.();
    }

    #tick(): void {
        const persona = this.#persona();
        const now = this.#clock.now();
        const activity = isAsleep(persona, now) ? "asleep" : busyPeriod(persona, now) ? "busy" : "free";
        const present = activity === "free" || (activity === "busy" && this.#glancingAtPhone(persona, now));
        if (activity !== "busy") this.#nextPhoneCheck = 0;
        if (present !== this.#present) {
            this.#present = present;
            this.#trace.record("routine.change", { detail: { activity, present } });
            if (present) this.#arrive();
            else this.#leave();
        }
        this.#cancel = this.#clock.setTimer(TICK_MS, () => this.#tick());
    }

    #glancingAtPhone(persona: Persona, now: number): boolean {
        if (now < this.#phoneUntil) return true;
        const range = busyPeriod(persona, now)?.checkPhoneEveryMin;
        if (!range) return false;
        if (this.#nextPhoneCheck === 0) {
            this.#nextPhoneCheck = now + this.#rng.between(range[0], range[1]) * MINUTE_MS;
            return false;
        }
        if (now < this.#nextPhoneCheck) return false;
        this.#phoneUntil = now + this.#rng.between(PHONE_CHECK_MINUTES[0], PHONE_CHECK_MINUTES[1]) * MINUTE_MS;
        this.#nextPhoneCheck = this.#phoneUntil + this.#rng.between(range[0], range[1]) * MINUTE_MS;
        return true;
    }
}

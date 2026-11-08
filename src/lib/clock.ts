export type CancelTimer = () => void;

/** All time flows through this, so schedules, decay and delays are testable. */
export interface Clock {
    now(): number;
    setTimer(delayMs: number, fn: () => void): CancelTimer;
}

export class SystemClock implements Clock {
    now(): number {
        return Date.now();
    }

    setTimer(delayMs: number, fn: () => void): CancelTimer {
        const handle = setTimeout(fn, delayMs);
        return () => clearTimeout(handle);
    }
}

type ManualTimer = { due: number; order: number; fn: () => void };

/** Time only moves when a test calls `advance`. Timers fire in due order, and pending async work settles between them. */
export class ManualClock implements Clock {
    #now: number;
    #timers: ManualTimer[] = [];
    #nextOrder = 0;

    constructor(startMs = 0) {
        this.#now = startMs;
    }

    now(): number {
        return this.#now;
    }

    setTimer(delayMs: number, fn: () => void): CancelTimer {
        const timer: ManualTimer = { due: this.#now + Math.max(0, delayMs), order: this.#nextOrder++, fn };
        this.#timers.push(timer);
        return () => {
            this.#timers = this.#timers.filter((t) => t !== timer);
        };
    }

    async advance(ms: number): Promise<void> {
        const target = this.#now + ms;
        await settle();
        for (;;) {
            const next = this.#earliestBy(target);
            if (!next) break;
            this.#timers = this.#timers.filter((t) => t !== next);
            this.#now = next.due;
            next.fn();
            await settle();
        }
        this.#now = target;
        await settle();
    }

    #earliestBy(target: number): ManualTimer | undefined {
        let best: ManualTimer | undefined;
        for (const timer of this.#timers) {
            if (timer.due > target) continue;
            if (!best || timer.due < best.due || (timer.due === best.due && timer.order < best.order)) best = timer;
        }
        return best;
    }
}

function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Resolves true once the delay has passed, or false if the signal aborted first. */
export function sleep(clock: Clock, delayMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        const onAbort = () => {
            cancel();
            resolve(false);
        };
        const cancel = clock.setTimer(delayMs, () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

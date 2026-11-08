import type { Clock } from "../lib/clock.ts";
import type { DecisionTrace } from "../lib/trace.ts";

export type BodyState = "idle" | "reading" | "composing" | "sending" | "away";
export type ActiveState = Extract<BodyState, "reading" | "composing" | "sending">;

/** A channel asking for attention. Channels never act on their own. */
export type Candidate = {
    channel: string;
    snapshotSeq: number;
    priority: number;
    expiresAt: number;
};

export type Lease = {
    candidate: Candidate;
    /** Aborts when attention is pulled away. Check it before every visible action. */
    signal: AbortSignal;
    setState(state: ActiveState): void;
};

export type Attend = (lease: Lease) => Promise<void>;

type Current = { candidate: Candidate; controller: AbortController };

/**
 * The agent's single body across every platform. It attends to one channel at a time,
 * and holding attention is a revocable lease rather than a lock held through long delays.
 */
export class BodyActor {
    #clock: Clock;
    #trace: DecisionTrace;
    #attend: Attend;
    #preemptMargin: number;
    #pending = new Map<string, Candidate>();
    #state: Exclude<BodyState, "away"> = "idle";
    #current: Current | undefined;
    #away = false;
    #running = false;
    #idleWaiters: (() => void)[] = [];

    constructor(options: { clock: Clock; trace: DecisionTrace; attend: Attend; preemptMargin?: number }) {
        this.#clock = options.clock;
        this.#trace = options.trace;
        this.#attend = options.attend;
        this.#preemptMargin = options.preemptMargin ?? 5;
    }

    get state(): BodyState {
        return this.#away && !this.#current ? "away" : this.#state;
    }

    /** A newer candidate replaces any waiting one from the same channel. */
    offer(candidate: Candidate): void {
        this.#pending.set(candidate.channel, candidate);
        this.#trace.record("body.offer", { channel: candidate.channel, detail: { priority: candidate.priority, seq: candidate.snapshotSeq } });
        this.#maybePreempt(candidate);
        this.#wake();
    }

    goAway(): void {
        if (this.#away) return;
        this.#away = true;
        this.#trace.record("body.away");
        this.#current?.controller.abort("away");
    }

    comeBack(): void {
        if (!this.#away) return;
        this.#away = false;
        this.#trace.record("body.back");
        this.#wake();
    }

    /** Resolves once nothing is being attended to and no candidate can run. */
    whenIdle(): Promise<void> {
        if (!this.#running) return Promise.resolve();
        return new Promise((resolve) => this.#idleWaiters.push(resolve));
    }

    #maybePreempt(candidate: Candidate): void {
        const current = this.#current;
        if (!current || this.#state === "sending" || current.candidate.channel === candidate.channel) return;
        if (candidate.priority < current.candidate.priority + this.#preemptMargin) return;
        this.#trace.record("body.preempt", { channel: current.candidate.channel, detail: { by: candidate.channel } });
        current.controller.abort("preempted");
    }

    #wake(): void {
        if (this.#running || this.#away) return;
        this.#running = true;
        // Deferred so that offers made in the same tick are compared before one is chosen.
        queueMicrotask(() => void this.#drain());
    }

    async #drain(): Promise<void> {
        while (!this.#away) {
            const candidate = this.#takeNext();
            if (!candidate) break;
            await this.#runLease(candidate);
        }
        this.#running = false;
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }

    async #runLease(candidate: Candidate): Promise<void> {
        const controller = new AbortController();
        const current: Current = { candidate, controller };
        this.#current = current;
        this.#state = "reading";
        this.#trace.record("body.attend", { channel: candidate.channel, detail: { seq: candidate.snapshotSeq } });
        const lease: Lease = {
            candidate,
            signal: controller.signal,
            setState: (state) => {
                if (this.#current === current && !controller.signal.aborted) this.#state = state;
            },
        };
        try {
            await this.#attend(lease);
        } catch (error) {
            this.#trace.record("body.attend_failed", { channel: candidate.channel, detail: { error: String(error) } });
        }
        this.#current = undefined;
        this.#state = "idle";
        // An interrupted channel goes back in line, unless something newer has already replaced it.
        if (controller.signal.aborted && !this.#pending.has(candidate.channel)) this.#pending.set(candidate.channel, candidate);
    }

    #takeNext(): Candidate | undefined {
        const now = this.#clock.now();
        let best: Candidate | undefined;
        for (const candidate of this.#pending.values()) {
            if (candidate.expiresAt <= now) {
                this.#pending.delete(candidate.channel);
                this.#trace.record("body.expired", { channel: candidate.channel });
            } else if (!best || candidate.priority > best.priority) {
                best = candidate;
            }
        }
        if (best) this.#pending.delete(best.channel);
        return best;
    }
}

import type { ChatMessage } from "../adapters/types.ts";
import type { Candidate } from "../body/actor.ts";
import type { CancelTimer, Clock } from "../lib/clock.ts";

export type PerceptionTiming = {
    /** Wait for this much silence before reacting. */
    quietMs: number;
    /** React after this long regardless, or an active chat would never fire. */
    maxWaitMs: number;
    /** How long an offer stays worth acting on. */
    candidateTtlMs: number;
    windowSize: number;
};

const NORMAL_PRIORITY = 1;
export const ADDRESSED_PRIORITY = 10;

/** What one channel looks like from the outside: debounced, with a short rolling window. */
export class ChannelPerception {
    #channel: string;
    #clock: Clock;
    #timing: PerceptionTiming;
    #onReady: (candidate: Candidate) => void;
    #window: { message: ChatMessage; seq: number }[] = [];
    #seq = 0;
    #settledSeq = 0;
    #firstUnhandledAt: number | undefined;
    #addressedSinceLastOffer = false;
    #cancelTimer: CancelTimer | undefined;

    constructor(options: { channel: string; clock: Clock; timing: PerceptionTiming; onReady: (candidate: Candidate) => void }) {
        this.#channel = options.channel;
        this.#clock = options.clock;
        this.#timing = options.timing;
        this.#onReady = options.onReady;
    }

    ingest(message: ChatMessage): void {
        this.#seq++;
        this.#push(message);
        if (message.mentionsSelf || message.repliesToSelf) this.#addressedSinceLastOffer = true;

        const now = this.#clock.now();
        this.#firstUnhandledAt ??= now;
        const untilMaxWait = this.#firstUnhandledAt + this.#timing.maxWaitMs - now;
        this.#cancelTimer?.();
        this.#cancelTimer = this.#clock.setTimer(Math.min(this.#timing.quietMs, untilMaxWait), () => this.#fire());
    }

    /** Records the agent's own sent message, without treating it as something to react to. */
    recordOwn(message: ChatMessage): void {
        this.#push(message);
    }

    /** Keeps a message as context without it ever counting as new or waking the agent. */
    recordSeen(message: ChatMessage): void {
        this.#window.push({ message, seq: 0 });
        if (this.#window.length > this.#timing.windowSize) this.#window.shift();
    }

    window(): readonly ChatMessage[] {
        return this.#window.map((entry) => entry.message);
    }

    get seq(): number {
        return this.#seq;
    }

    /** Where the messages the agent hasn't dealt with yet begin, or undefined if there are none. */
    firstNewIndex(): number | undefined {
        const index = this.#window.findIndex((entry) => entry.seq > this.#settledSeq && !entry.message.isSelf);
        return index === -1 ? undefined : index;
    }

    /** Everything up to `seq` has been answered or deliberately let go. */
    settle(seq: number): void {
        this.#settledSeq = Math.max(this.#settledSeq, seq);
    }

    #push(message: ChatMessage): void {
        this.#window.push({ message, seq: this.#seq });
        if (this.#window.length > this.#timing.windowSize) this.#window.shift();
    }

    #fire(): void {
        this.#cancelTimer = undefined;
        this.#firstUnhandledAt = undefined;
        const priority = this.#addressedSinceLastOffer ? ADDRESSED_PRIORITY : NORMAL_PRIORITY;
        this.#addressedSinceLastOffer = false;
        this.#onReady({
            channel: this.#channel,
            snapshotSeq: this.#seq,
            priority,
            expiresAt: this.#clock.now() + this.#timing.candidateTtlMs,
        });
    }
}

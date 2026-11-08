import type { Clock } from "./clock.ts";

export type TraceFields = {
    channel?: string;
    messageId?: string;
    detail?: Record<string, unknown>;
};

export type TraceEvent = TraceFields & { at: number; kind: string };

/** Records every decision. An agent that stays silent looks like a crash, so this is how you tell the two apart. */
export class DecisionTrace {
    #clock: Clock;
    #capacity: number;
    #events: TraceEvent[] = [];
    #sink: ((event: TraceEvent) => void) | undefined;

    constructor(clock: Clock, options: { capacity?: number; sink?: (event: TraceEvent) => void } = {}) {
        this.#clock = clock;
        this.#capacity = options.capacity ?? 10_000;
        this.#sink = options.sink;
    }

    record(kind: string, fields: TraceFields = {}): void {
        const event: TraceEvent = { at: this.#clock.now(), kind, ...fields };
        this.#events.push(event);
        if (this.#events.length > this.#capacity) this.#events.shift();
        this.#sink?.(event);
    }

    all(): readonly TraceEvent[] {
        return this.#events;
    }

    ofKind(kind: string): TraceEvent[] {
        return this.#events.filter((event) => event.kind === kind);
    }

    forMessage(messageId: string): TraceEvent[] {
        return this.#events.filter((event) => event.messageId === messageId);
    }
}

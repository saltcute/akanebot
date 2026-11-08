import type { Adapter, ChannelRef, ChatMessage, SendOptions } from "../adapters/types.ts";
import { channelKey } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";
import type { DecisionTrace } from "../lib/trace.ts";

export type GuardLimits = {
    /** Largest burst of messages across all channels. */
    bucketCapacity: number;
    refillPerMinute: number;
    /** How many recent messages per channel count towards the agent's share. */
    shareWindow: number;
    /** The agent stops talking above this fraction of recent messages. */
    maxShare: number;
    /** The share breaker ignores channels with fewer recent messages than this. */
    minShareSample: number;
};

export type Observation = "new" | "duplicate" | "self_echo" | "backlog";

export type SendOutcome =
    | { kind: "sent"; messageId: string }
    | { kind: "blocked"; reason: "aborted" | "rate_limited" | "share_breaker" }
    /** Delivery is unknown. It is never retried, because a retry after a timeout double-posts. */
    | { kind: "failed"; detail: string };

const MAX_REMEMBERED_IDS = 5000;

/** The last line of defence against double-posting, echo loops and spam. */
export class SendGuard {
    #clock: Clock;
    #trace: DecisionTrace;
    #limits: GuardLimits;
    #seen = new Set<string>();
    #recent = new Map<string, boolean[]>();
    #tokens: number;
    #lastRefill: number;

    constructor(options: { clock: Clock; trace: DecisionTrace; limits: GuardLimits }) {
        this.#clock = options.clock;
        this.#trace = options.trace;
        this.#limits = options.limits;
        this.#tokens = options.limits.bucketCapacity;
        this.#lastRefill = options.clock.now();
    }

    /** Classifies an incoming event. Only "new" messages may reach perception. */
    observe(message: ChatMessage): Observation {
        const id = idKey(message, message.messageId);
        if (message.isSelf || this.#isOwnSend(message)) return "self_echo";
        if (this.#seen.has(id)) return "duplicate";
        this.#remember(id);
        if (message.isBacklog) return "backlog";
        this.#recordShare(channelKey(message), false);
        return "new";
    }

    async send(adapter: Adapter, channel: ChannelRef, text: string, options: SendOptions = {}): Promise<SendOutcome> {
        const key = channelKey(channel);
        if (options.signal?.aborted) return this.#blocked(key, "aborted");
        if (this.#shareExceeded(key)) return this.#blocked(key, "share_breaker");
        if (!this.#takeToken()) return this.#blocked(key, "rate_limited");

        try {
            const { messageId } = await adapter.send(channel, text, options);
            this.#remember(ownKey(channel, messageId));
            this.#recordShare(key, true);
            this.#trace.record("send.sent", { channel: key, messageId, detail: { text } });
            return { kind: "sent", messageId };
        } catch (error) {
            const detail = String(error);
            this.#trace.record("send.failed", { channel: key, detail: { error: detail } });
            return { kind: "failed", detail };
        }
    }

    #blocked(channel: string, reason: "aborted" | "rate_limited" | "share_breaker"): SendOutcome {
        this.#trace.record("send.blocked", { channel, detail: { reason } });
        return { kind: "blocked", reason };
    }

    #isOwnSend(message: ChatMessage): boolean {
        return this.#seen.has(ownKey(message, message.messageId));
    }

    #remember(id: string): void {
        this.#seen.add(id);
        if (this.#seen.size <= MAX_REMEMBERED_IDS) return;
        const oldest = this.#seen.values().next().value;
        if (oldest !== undefined) this.#seen.delete(oldest);
    }

    #recordShare(channel: string, isSelf: boolean): void {
        const recent = this.#recent.get(channel) ?? [];
        recent.push(isSelf);
        if (recent.length > this.#limits.shareWindow) recent.shift();
        this.#recent.set(channel, recent);
    }

    #shareExceeded(channel: string): boolean {
        const recent = this.#recent.get(channel) ?? [];
        if (recent.length < this.#limits.minShareSample) return false;
        return recent.filter(Boolean).length / recent.length > this.#limits.maxShare;
    }

    #takeToken(): boolean {
        const now = this.#clock.now();
        const refilled = ((now - this.#lastRefill) / 60_000) * this.#limits.refillPerMinute;
        this.#tokens = Math.min(this.#limits.bucketCapacity, this.#tokens + refilled);
        this.#lastRefill = now;
        if (this.#tokens < 1) return false;
        this.#tokens -= 1;
        return true;
    }
}

function idKey(channel: ChannelRef, messageId: string): string {
    return `${channelKey(channel)}:${messageId}`;
}

function ownKey(channel: ChannelRef, messageId: string): string {
    return `self:${idKey(channel, messageId)}`;
}

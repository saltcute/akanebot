import type { Adapter, ChannelRef, ChatMessage, SendOptions } from "../adapters/types.ts";
import { channelKey } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";
import type { DecisionTrace } from "../lib/trace.ts";
import type { ReactionChoice } from "../persona/schema.ts";

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

type BlockReason = "aborted" | "rate_limited" | "share_breaker" | "bot_loop" | "shadow";
type Speaker = "self" | "bot" | "human";

export type SendOutcome =
    | { kind: "sent"; messageId: string }
    | { kind: "blocked"; reason: BlockReason }
    /** Delivery is unknown. It is never retried, because a retry after a timeout double-posts. */
    | { kind: "failed"; detail: string };

const MAX_REMEMBERED_IDS = 5000;
/** With no human among this many recent messages, the agent is just talking to another bot. */
const BOT_LOOP_WINDOW = 8;

/** The last line of defence against double-posting, echo loops and spam. */
export class SendGuard {
    #clock: Clock;
    #trace: DecisionTrace;
    #limits: GuardLimits;
    #seen = new Set<string>();
    #recent = new Map<string, Speaker[]>();
    #tokens: number;
    #lastRefill: number;
    #shadow: boolean;

    constructor(options: { clock: Clock; trace: DecisionTrace; limits: GuardLimits; shadow?: boolean }) {
        this.#clock = options.clock;
        this.#trace = options.trace;
        this.#limits = options.limits;
        this.#tokens = options.limits.bucketCapacity;
        this.#lastRefill = options.clock.now();
        this.#shadow = options.shadow ?? false;
    }

    /** Classifies an incoming event. Only "new" messages may reach perception. */
    observe(message: ChatMessage): Observation {
        const id = idKey(message, message.messageId);
        if (message.isSelf || this.#isOwnSend(message)) return "self_echo";
        if (this.#seen.has(id)) return "duplicate";
        this.#remember(id);
        if (message.isBacklog) return "backlog";
        this.#recordSpeaker(channelKey(message), message.sender.isBot ? "bot" : "human");
        return "new";
    }

    async send(adapter: Adapter, channel: ChannelRef, text: string, options: SendOptions = {}): Promise<SendOutcome> {
        const key = channelKey(channel);
        if (options.signal?.aborted) return this.#blocked(key, "aborted");
        if (this.#shareExceeded(key)) return this.#blocked(key, "share_breaker");
        if (this.#inBotLoop(key)) return this.#blocked(key, "bot_loop");
        if (!this.#takeToken()) return this.#blocked(key, "rate_limited");
        return this.#deliver(adapter, channel, text, options);
    }

    /** A reaction counts against the rate limit but not as talking. */
    async react(adapter: Adapter, channel: ChannelRef, messageId: string, reaction: ReactionChoice): Promise<"reacted" | "shadow" | "failed"> {
        const key = channelKey(channel);
        if (this.#shadow) {
            this.#trace.record("send.shadow", { channel: key, messageId, detail: { text: `(reacts ${reaction.label})` } });
            return "shadow";
        }
        if (!adapter.react || !this.#takeToken()) return "failed";
        try {
            await adapter.react(channel, messageId, reaction.id);
            this.#trace.record("send.reacted", { channel: key, messageId, detail: { emoji: reaction.label } });
            return "reacted";
        } catch (error) {
            this.#trace.record("send.failed", { channel: key, messageId, detail: { error: String(error) } });
            return "failed";
        }
    }

    /** Cosmetic, so a failure here is ignored. */
    async typing(adapter: Adapter, channel: ChannelRef): Promise<void> {
        if (this.#shadow) return;
        await adapter.sendTyping(channel).catch(() => {});
    }

    /** For safety responses and admin confirmations, which must get through. Still at-most-once. */
    sendUrgent(adapter: Adapter, channel: ChannelRef, text: string): Promise<SendOutcome> {
        return this.#deliver(adapter, channel, text, {});
    }

    async #deliver(adapter: Adapter, channel: ChannelRef, text: string, options: SendOptions): Promise<SendOutcome> {
        const key = channelKey(channel);
        const mention = options.mention ? { mention: text.slice(options.mention.start + 1, options.mention.end) } : {};
        if (this.#shadow) {
            const replyTo = options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {};
            this.#trace.record("send.shadow", { channel: key, detail: { text, ...replyTo, ...mention } });
            return { kind: "blocked", reason: "shadow" };
        }
        try {
            const { messageId } = await adapter.send(channel, text, options);
            this.#remember(ownKey(channel, messageId));
            this.#recordSpeaker(key, "self");
            this.#trace.record("send.sent", { channel: key, messageId, detail: { text, ...mention } });
            return { kind: "sent", messageId };
        } catch (error) {
            const detail = String(error);
            this.#trace.record("send.failed", { channel: key, detail: { error: detail } });
            return { kind: "failed", detail };
        }
    }

    #blocked(channel: string, reason: BlockReason): SendOutcome {
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

    #recordSpeaker(channel: string, speaker: Speaker): void {
        const recent = this.#recent.get(channel) ?? [];
        recent.push(speaker);
        if (recent.length > this.#limits.shareWindow) recent.shift();
        this.#recent.set(channel, recent);
    }

    #shareExceeded(channel: string): boolean {
        const recent = this.#recent.get(channel) ?? [];
        if (recent.length < this.#limits.minShareSample) return false;
        return recent.filter((speaker) => speaker === "self").length / recent.length > this.#limits.maxShare;
    }

    #inBotLoop(channel: string): boolean {
        const latest = (this.#recent.get(channel) ?? []).slice(-BOT_LOOP_WINDOW);
        return latest.length === BOT_LOOP_WINDOW && !latest.includes("human") && latest.includes("self");
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

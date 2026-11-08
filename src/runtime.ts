import type { Adapter, ChannelRef, ChatMessage, Platform } from "./adapters/types.ts";
import { channelKey } from "./adapters/types.ts";
import { type Attend, BodyActor, type Lease } from "./body/actor.ts";
import type { Clock } from "./lib/clock.ts";
import type { DecisionTrace } from "./lib/trace.ts";
import type { LlmRegistry } from "./llm/registry.ts";
import { ChannelPerception, type PerceptionTiming } from "./perception/channel.ts";
import { type GuardLimits, SendGuard } from "./reply/guards.ts";

export type RuntimeOptions = {
    clock: Clock;
    trace: DecisionTrace;
    llm: LlmRegistry;
    adapters: readonly Adapter[];
    timing: PerceptionTiming;
    limits: GuardLimits;
};

type Channel = { ref: ChannelRef; adapter: Adapter; perception: ChannelPerception };

/** Wires adapters to perception, the body and the send guards. */
export class Runtime {
    readonly body: BodyActor;
    readonly guard: SendGuard;
    #options: RuntimeOptions;
    #adapters: ReadonlyMap<Platform, Adapter>;
    #channels = new Map<string, Channel>();

    constructor(options: RuntimeOptions) {
        this.#options = options;
        this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
        this.guard = new SendGuard({ clock: options.clock, trace: options.trace, limits: options.limits });
        const attend: Attend = (lease) => this.#attend(lease);
        this.body = new BodyActor({ clock: options.clock, trace: options.trace, attend });
    }

    async start(): Promise<void> {
        await Promise.all(this.#options.adapters.map((adapter) => adapter.start((message) => this.#onMessage(message))));
    }

    async stop(): Promise<void> {
        await Promise.all(this.#options.adapters.map((adapter) => adapter.stop()));
    }

    #onMessage(message: ChatMessage): void {
        const key = channelKey(message);
        const observation = this.guard.observe(message);
        this.#options.trace.record("message.observed", { channel: key, messageId: message.messageId, detail: { observation } });
        if (observation !== "new") return;
        this.#channel(message).perception.ingest(message);
    }

    #channel(ref: ChannelRef): Channel {
        const key = channelKey(ref);
        const existing = this.#channels.get(key);
        if (existing) return existing;
        const adapter = this.#adapters.get(ref.platform);
        if (!adapter) throw new Error(`No adapter for platform "${ref.platform}"`);
        const perception = new ChannelPerception({
            channel: key,
            clock: this.#options.clock,
            timing: this.#options.timing,
            onReady: (candidate) => this.body.offer(candidate),
        });
        const channel: Channel = { ref: { platform: ref.platform, channelId: ref.channelId }, adapter, perception };
        this.#channels.set(key, channel);
        return channel;
    }

    async #attend(lease: Lease): Promise<void> {
        const { trace, llm } = this.#options;
        const key = lease.candidate.channel;
        const channel = this.#channels.get(key);
        if (!channel) return;

        lease.setState("composing");
        const transcript = renderTranscript(channel.perception.window());
        const result = await llm.generate("reply", { stable: "", transcript, volatile: "", maxOutput: 512, signal: lease.signal });
        if (result.kind !== "ok" || result.text.trim() === "") {
            // Failures never reach the chat. The trace is where the operator finds them.
            trace.record("reply.silent", { channel: key, detail: { result: result.kind } });
            return;
        }

        lease.setState("sending");
        const outcome = await this.guard.send(channel.adapter, channel.ref, result.text, { signal: lease.signal });
        if (outcome.kind === "sent") channel.perception.recordOwn(ownMessage(channel.ref, outcome.messageId, result.text, this.#options.clock.now()));
    }
}

function renderTranscript(window: readonly ChatMessage[]): string {
    return window.map((message) => `${message.sender.displayName}: ${message.text}`).join("\n");
}

function ownMessage(ref: ChannelRef, messageId: string, text: string, sentAt: number): ChatMessage {
    return {
        ...ref,
        messageId,
        text,
        sentAt,
        sender: { id: "self", displayName: "me", isBot: false },
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: true,
        isBacklog: false,
    };
}

import type { Adapter, ChannelRef, ChatMessage, Platform } from "./adapters/types.ts";
import { channelKey } from "./adapters/types.ts";
import { type Attend, BodyActor, type Lease } from "./body/actor.ts";
import { assessCompetence } from "./gate/competence.ts";
import { type GateFeatures, gateFeaturesSchema, renderGateInstructions } from "./gate/features.ts";
import { decideToSpeak } from "./gate/policy.ts";
import type { Clock } from "./lib/clock.ts";
import type { CostMeter } from "./lib/cost.ts";
import type { Rng } from "./lib/rng.ts";
import type { DecisionTrace } from "./lib/trace.ts";
import type { LlmRegistry } from "./llm/registry.ts";
import { ADDRESSED_PRIORITY, ChannelPerception, type PerceptionTiming } from "./perception/channel.ts";
import type { Persona } from "./persona/schema.ts";
import { exceedsCodeLimit, toBursts } from "./reply/bursts.ts";
import { type GuardLimits, SendGuard } from "./reply/guards.ts";
import { renderReplyInstructions, renderReplyState, renderTranscript, replySchema } from "./reply/prompt.ts";

export type RuntimeOptions = {
    clock: Clock;
    rng: Rng;
    trace: DecisionTrace;
    llm: LlmRegistry;
    cost: CostMeter;
    persona: Persona;
    adapters: readonly Adapter[];
    timing: PerceptionTiming;
    limits: GuardLimits;
};

type Channel = { ref: ChannelRef; adapter: Adapter; perception: ChannelPerception };

const GATE_MAX_OUTPUT = 600;
const REPLY_MAX_OUTPUT = 2000;
const TECHNICAL_MAX_OUTPUT = 4000;

/** Wires adapters to perception, the body, the gate and the send guards. */
export class Runtime {
    readonly body: BodyActor;
    readonly guard: SendGuard;
    #options: RuntimeOptions;
    #adapters: ReadonlyMap<Platform, Adapter>;
    #channels = new Map<string, Channel>();
    #gateRng: Rng;
    #competenceRng: Rng;

    constructor(options: RuntimeOptions) {
        this.#options = options;
        this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
        this.#gateRng = options.rng.fork("gate");
        this.#competenceRng = options.rng.fork("competence");
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
        const { trace, llm, cost, persona } = this.#options;
        const key = lease.candidate.channel;
        const channel = this.#channels.get(key);
        if (!channel) return;
        if (cost.overBudget()) {
            trace.record("budget.exceeded", { channel: key, detail: cost.summary() });
            return;
        }

        const { perception } = channel;
        const firstNewIndex = perception.firstNewIndex();
        if (firstNewIndex === undefined) return;
        const seenSeq = perception.seq;
        const window = perception.window();
        const messageId = window.at(-1)?.messageId;
        const idField = messageId ? { messageId } : {};
        const transcript = renderTranscript(window, persona, firstNewIndex);
        const gate = await llm.generate("gate", {
            stable: renderGateInstructions(persona),
            transcript,
            volatile: "",
            schema: gateFeaturesSchema,
            maxOutput: GATE_MAX_OUTPUT,
            signal: lease.signal,
        });
        if (gate.kind !== "ok" || !gate.data) {
            trace.record("gate.silent", { channel: key, ...idField, detail: describeFailure(gate) });
            return;
        }

        const features: GateFeatures = gate.data;
        const mentioned = lease.candidate.priority >= ADDRESSED_PRIORITY;
        const decision = decideToSpeak(features, persona, mentioned, this.#gateRng);
        const competence = assessCompetence(features, persona, this.#competenceRng);
        trace.record("gate.decision", { channel: key, ...idField, detail: { ...decision, ...competence, features } });
        if (!decision.speak) {
            perception.settle(seenSeq);
            return;
        }

        lease.setState("composing");
        const technical = competence.mode !== "casual";
        const result = await llm.generate(technical ? "technical" : "reply", {
            stable: renderReplyInstructions(persona),
            transcript,
            volatile: renderReplyState({ now: this.#options.clock.now(), persona, features, competence, addressed: decision.addressed }),
            schema: replySchema,
            maxOutput: technical ? TECHNICAL_MAX_OUTPUT : REPLY_MAX_OUTPUT,
            signal: lease.signal,
        });
        if (result.kind !== "ok" || !result.data) {
            // Failures never reach the chat. The trace is where the operator finds them.
            trace.record("reply.silent", { channel: key, ...idField, detail: describeFailure(result) });
            return;
        }

        const bursts = toBursts(result.data.messages);
        if (bursts.length === 0) {
            perception.settle(seenSeq);
            trace.record("reply.chose_silence", { channel: key, ...idField });
            return;
        }
        if (exceedsCodeLimit(bursts, persona.maxCodeLines)) {
            perception.settle(seenSeq);
            trace.record("reply.code_too_long", { channel: key, ...idField });
            return;
        }

        lease.setState("sending");
        for (const text of bursts) {
            const outcome = await this.guard.send(channel.adapter, channel.ref, text, { signal: lease.signal });
            if (outcome.kind !== "sent") return;
            // Settled on the first send, so a reply cut short partway is never answered a second time.
            perception.settle(seenSeq);
            perception.recordOwn(ownMessage(channel.ref, outcome.messageId, text, this.#options.clock.now(), persona.name));
        }
    }
}

function describeFailure(result: { kind: string; detail?: string }): Record<string, unknown> {
    return { result: result.kind, ...(result.detail ? { error: result.detail } : {}) };
}

function ownMessage(ref: ChannelRef, messageId: string, text: string, sentAt: number, name: string): ChatMessage {
    return {
        ...ref,
        messageId,
        text,
        sentAt,
        sender: { id: "self", displayName: name, isBot: false },
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: true,
        isBacklog: false,
    };
}

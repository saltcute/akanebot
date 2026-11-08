import type { Adapter, ChannelRef, ChatMessage, Platform } from "./adapters/types.ts";
import { channelKey } from "./adapters/types.ts";
import { type Attend, BodyActor, type Lease } from "./body/actor.ts";
import { runCommand } from "./control/admin.ts";
import {
    CrisisDesk,
    crisisFallback,
    crisisVerdictSchema,
    mentionsSelfHarm,
    renderCrisisClassifier,
    renderCrisisInstructions,
} from "./control/crisis.ts";
import { ControlState, type ControlStore, userKey } from "./control/state.ts";
import { assessCompetence } from "./gate/competence.ts";
import { type GateFeatures, gateFeaturesSchema, renderGateInstructions } from "./gate/features.ts";
import { decideToSpeak } from "./gate/policy.ts";
import type { Clock } from "./lib/clock.ts";
import type { CostMeter } from "./lib/cost.ts";
import type { Rng } from "./lib/rng.ts";
import type { DecisionTrace } from "./lib/trace.ts";
import type { Embedder } from "./llm/embedder.ts";
import type { LlmRegistry } from "./llm/registry.ts";
import type { MemoryStore } from "./memory/store.ts";
import { type MemorySettings, MemorySystem } from "./memory/system.ts";
import { ADDRESSED_PRIORITY, ChannelPerception, type PerceptionTiming } from "./perception/channel.ts";
import type { Persona } from "./persona/schema.ts";
import { exceedsCodeLimit, toBursts } from "./reply/bursts.ts";
import { type GuardLimits, SendGuard } from "./reply/guards.ts";
import { renderReplyInstructions, renderReplyState, renderTranscript, replySchema } from "./reply/prompt.ts";

export type ControlOptions = {
    commandPrefix: string;
    /** `platform:userId` of each person allowed to run admin commands. */
    admins: readonly string[];
    groups: readonly (ChannelRef & { disclosed: boolean })[];
    crisisResources: string;
};

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
    control: ControlOptions;
    controlStore: ControlStore;
    memoryStore: MemoryStore;
    embedder: Embedder;
    memorySettings: MemorySettings;
    /** Reads and decides, but never posts anything. */
    shadow?: boolean;
};

type Channel = { ref: ChannelRef; adapter: Adapter; perception: ChannelPerception };

const GATE_MAX_OUTPUT = 600;
const REPLY_MAX_OUTPUT = 2000;
const TECHNICAL_MAX_OUTPUT = 4000;
const CRISIS_CLASSIFIER_MAX_OUTPUT = 200;
const CRISIS_MAX_OUTPUT = 3000;

/** Wires adapters to perception, the body, the gate and the send guards. */
export class Runtime {
    readonly body: BodyActor;
    readonly guard: SendGuard;
    readonly memory: MemorySystem;
    #options: RuntimeOptions;
    #adapters: ReadonlyMap<Platform, Adapter>;
    #channels = new Map<string, Channel>();
    #gateRng: Rng;
    #competenceRng: Rng;
    #persona: Persona;
    #state: ControlState;
    #crisis: CrisisDesk;
    #allowedChannels: ReadonlySet<string>;
    #background = new Set<Promise<void>>();

    constructor(options: RuntimeOptions) {
        this.#options = options;
        this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
        this.#gateRng = options.rng.fork("gate");
        this.#competenceRng = options.rng.fork("competence");
        this.guard = new SendGuard({ clock: options.clock, trace: options.trace, limits: options.limits, shadow: options.shadow ?? false });
        const attend: Attend = (lease) => this.#attend(lease);
        this.body = new BodyActor({ clock: options.clock, trace: options.trace, attend });
        this.#persona = options.persona;
        this.#state = new ControlState({ clock: options.clock, store: options.controlStore });
        this.#crisis = new CrisisDesk(options.clock);
        this.#allowedChannels = new Set(options.control.groups.filter((group) => group.disclosed).map(channelKey));
        if (this.#state.killed) this.body.goAway();
        this.memory = new MemorySystem({
            store: options.memoryStore,
            embedder: options.embedder,
            llm: options.llm,
            clock: options.clock,
            rng: options.rng.fork("recall"),
            trace: options.trace,
            persona: () => this.#persona,
            settings: options.memorySettings,
            alert: (reason, detail) => this.#alert(reason, detail),
        });
    }

    setPersona(persona: Persona): void {
        this.#persona = persona;
    }

    /** Resolves once the body is idle and no safety work is still running. */
    async whenIdle(): Promise<void> {
        do {
            await Promise.all(this.#background);
            await this.body.whenIdle();
            await this.memory.whenIdle();
        } while (this.#background.size > 0);
    }

    async start(): Promise<void> {
        await Promise.all(this.#options.adapters.map((adapter) => adapter.start((message) => this.#onMessage(message))));
        this.memory.start();
    }

    async stop(): Promise<void> {
        this.memory.stop();
        await Promise.all(this.#options.adapters.map((adapter) => adapter.stop()));
    }

    #onMessage(message: ChatMessage): void {
        const { trace, control } = this.#options;
        const key = channelKey(message);
        if (!this.#allowedChannels.has(key)) {
            trace.record("control.not_allowed", { channel: key, messageId: message.messageId });
            return;
        }
        const observation = this.guard.observe(message);
        trace.record("message.observed", { channel: key, messageId: message.messageId, detail: { observation } });
        if (observation !== "new") return;

        const channel = this.#channel(message);
        const command = runCommand(message, { prefix: control.commandPrefix, admins: control.admins, state: this.#state });
        if (command.handled) {
            trace.record("control.command", { channel: key, messageId: message.messageId });
            if (command.bodyEffect === "stop") this.body.goAway();
            if (command.bodyEffect === "resume") this.body.comeBack();
            if (command.forgetUser) this.#forgetUser(command.forgetUser);
            if (command.ack) this.#inBackground(this.#acknowledge(channel, command.ack, command.urgent));
            return;
        }
        if (this.#state.killed) return;
        const user = userKey(message);
        if (this.#state.isOptedOut(user)) {
            trace.record("control.opted_out", { channel: key, messageId: message.messageId });
            return;
        }

        // Safety runs here, ahead of perception, the body and the dice, so sleep and ignore rolls can't swallow it.
        if (this.#crisis.inEpisode(key, user)) {
            channel.perception.recordSeen(message);
            this.#inBackground(this.#respondToCrisis(channel, user, message.messageId));
        } else if (mentionsSelfHarm(message.text)) {
            this.#inBackground(this.#screenForCrisis(channel, message));
        } else {
            this.#admit(channel, message);
        }
    }

    #forgetUser(user: string): void {
        this.memory.forgetUser(user);
        for (const channel of this.#channels.values()) channel.perception.purge((message) => userKey(message) === user);
    }

    #admit(channel: Channel, message: ChatMessage): void {
        this.memory.recordIncoming(message);
        if (this.#state.isMuted(channelKey(channel.ref))) channel.perception.recordSeen(message);
        else channel.perception.ingest(message);
    }

    #inBackground(work: Promise<void>): void {
        const tracked: Promise<void> = work
            .catch((error) => this.#alert("background_failed", { error: String(error) }))
            .finally(() => this.#background.delete(tracked));
        this.#background.add(tracked);
    }

    #alert(reason: string, detail: Record<string, unknown>): void {
        this.#options.trace.record("alert", { detail: { reason, ...detail } });
    }

    async #acknowledge(channel: Channel, text: string, urgent: boolean): Promise<void> {
        // Not recorded in the window: confirmations belong to the operator's voice, not the persona's.
        if (urgent) await this.guard.sendUrgent(channel.adapter, channel.ref, text);
        else await this.guard.send(channel.adapter, channel.ref, text);
    }

    async #screenForCrisis(channel: Channel, message: ChatMessage): Promise<void> {
        const verdict = await this.#options.llm.generate("gate", {
            stable: renderCrisisClassifier(),
            transcript: renderTranscript([message], this.#persona),
            volatile: "",
            schema: crisisVerdictSchema,
            maxOutput: CRISIS_CLASSIFIER_MAX_OUTPUT,
            signal: new AbortController().signal,
        });
        // If the check itself fails, assume the worst: an unneeded kind word costs far less than a missed crisis.
        if (verdict.kind === "ok" && verdict.data && !verdict.data.isCrisis) {
            this.#admit(channel, message);
            return;
        }
        channel.perception.recordSeen(message);
        await this.#respondToCrisis(channel, userKey(message), message.messageId);
    }

    async #respondToCrisis(channel: Channel, user: string, messageId: string): Promise<void> {
        const { trace, llm, control } = this.#options;
        const key = channelKey(channel.ref);
        if (this.#state.killed) return;
        if (!this.#crisis.claimReply(key, user)) {
            this.#alert("crisis_reply_cap", { channel: key, user });
            return;
        }
        trace.record("control.crisis", { channel: key, messageId });
        this.#alert("crisis_response", { channel: key, user });

        const result = await llm.generate("crisis", {
            stable: renderCrisisInstructions(control.crisisResources),
            transcript: renderTranscript(channel.perception.window(), this.#persona),
            volatile: "",
            maxOutput: CRISIS_MAX_OUTPUT,
            signal: new AbortController().signal,
        });
        const generated = result.kind === "ok" ? result.text.trim() : "";
        if (generated === "") this.#alert("crisis_fallback_used", { channel: key, result: result.kind });
        const text = generated || crisisFallback(control.crisisResources);
        const outcome = await this.guard.sendUrgent(channel.adapter, channel.ref, text);
        if (outcome.kind === "sent") {
            channel.perception.recordOwn(ownMessage(channel.ref, outcome.messageId, text, this.#options.clock.now(), this.#persona.name));
        } else if (!(outcome.kind === "blocked" && outcome.reason === "shadow")) {
            this.#alert("crisis_send_failed", { channel: key, outcome });
        }
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
        for (const message of this.memory.restoreWindow(key, this.#options.timing.windowSize)) perception.recordSeen(message);
        this.#channels.set(key, channel);
        return channel;
    }

    async #attend(lease: Lease): Promise<void> {
        const { trace, llm, cost } = this.#options;
        const persona = this.#persona;
        const key = lease.candidate.channel;
        const channel = this.#channels.get(key);
        if (!channel) return;
        if (this.#state.killed || this.#state.isMuted(key)) return;
        if (this.#crisis.isHolding(key)) {
            // No banter next to someone in trouble. These messages stay read rather than being picked up later.
            channel.perception.settle(channel.perception.seq);
            trace.record("control.crisis_hold", { channel: key });
            return;
        }
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
            if (gate.kind === "error" && !lease.signal.aborted) this.#alert("gate_failed", { channel: key, ...describeFailure(gate) });
            return;
        }

        const newMessages = window.slice(firstNewIndex).filter((message) => !message.isSelf);
        this.memory.markAttended(key, newMessages);
        const features: GateFeatures = gate.data;
        const mentioned = lease.candidate.priority >= ADDRESSED_PRIORITY;
        const decision = decideToSpeak(features, persona, mentioned, this.#gateRng);
        const competence = assessCompetence(features, persona, this.#competenceRng);
        trace.record("gate.decision", { channel: key, ...idField, detail: { ...decision, ...competence, features } });
        if (features.possibleCrisis) {
            const author = window.findLast((message) => !message.isSelf);
            perception.settle(seenSeq);
            if (author) await this.#respondToCrisis(channel, userKey(author), author.messageId);
            return;
        }
        if (!decision.speak) {
            perception.settle(seenSeq);
            return;
        }

        lease.setState("composing");
        const { block: memories } = await this.memory.recall(key, newMessages);
        const technical = competence.mode !== "casual";
        const result = await llm.generate(technical ? "technical" : "reply", {
            stable: renderReplyInstructions(persona),
            transcript: `${memories}${transcript}`,
            volatile: renderReplyState({ now: this.#options.clock.now(), persona, features, competence, addressed: decision.addressed }),
            schema: replySchema,
            maxOutput: technical ? TECHNICAL_MAX_OUTPUT : REPLY_MAX_OUTPUT,
            signal: lease.signal,
        });
        if (result.kind !== "ok" || !result.data) {
            // Failures never reach the chat. The trace is where the operator finds them.
            trace.record("reply.silent", { channel: key, ...idField, detail: describeFailure(result) });
            if (!lease.signal.aborted) this.#alert("reply_failed", { channel: key, ...describeFailure(result) });
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
            if (outcome.kind === "blocked" && outcome.reason === "shadow") {
                perception.settle(seenSeq);
                continue;
            }
            if (outcome.kind !== "sent") return;
            // Settled on the first send, so a reply cut short partway is never answered a second time.
            perception.settle(seenSeq);
            const own = ownMessage(channel.ref, outcome.messageId, text, this.#options.clock.now(), persona.name);
            perception.recordOwn(own);
            this.memory.recordOwn(own);
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

import type { ChatMessage } from "../adapters/types.ts";
import { isAsleep, localTime } from "../body/schedule.ts";
import { userKey } from "../control/state.ts";
import type { CancelTimer, Clock } from "../lib/clock.ts";
import type { Rng } from "../lib/rng.ts";
import type { DecisionTrace } from "../lib/trace.ts";
import type { Embedder } from "../llm/embedder.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { Persona } from "../persona/schema.ts";
import { type ConsolidationReport, consolidate } from "./consolidate.ts";
import { clampUnit, type Extraction, extractionSchema, renderExtractionInstructions, renderNumberedTranscript } from "./extract.ts";
import { judgeCandidate, type Participant } from "./poison-guards.ts";
import { MAX_STRENGTH, type Recalled, renderMemories, STRENGTH_GAIN, selectMemories } from "./recall.ts";
import type { MemoryStore } from "./store.ts";

export type MemorySettings = {
    /** A conversation counts as over after this long without anything attended. */
    segmentGapMs: number;
    maxSegmentMessages: number;
    rawRetentionMs: number;
    /** How many memories one person can create per day. */
    dailyWritesPerUser: number;
};

/** Scoring below this means even the model calls it nothing. Anything above is kept and left to fade on its own. */
const MIN_KEPT_IMPORTANCE = 0.2;
const EXTRACTION_MAX_OUTPUT = 3000;
const NIGHTLY_CHECK_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const LAST_CONSOLIDATION_KEY = "lastConsolidationDate";

/** Everything the agent remembers, and how it forgets. Only attended messages ever enter it. */
export class MemorySystem {
    readonly store: MemoryStore;
    #embedder: Embedder;
    #llm: LlmRegistry;
    #clock: Clock;
    #rng: Rng;
    #trace: DecisionTrace;
    #persona: () => Persona;
    #settings: MemorySettings;
    #alert: (reason: string, detail: Record<string, unknown>) => void;
    #segmentTimers = new Map<string, CancelTimer>();
    #closing = new Set<string>();
    #cancelNightly: CancelTimer | undefined;
    #background = new Set<Promise<unknown>>();

    constructor(options: {
        store: MemoryStore;
        embedder: Embedder;
        llm: LlmRegistry;
        clock: Clock;
        rng: Rng;
        trace: DecisionTrace;
        persona: () => Persona;
        settings: MemorySettings;
        alert: (reason: string, detail: Record<string, unknown>) => void;
    }) {
        this.store = options.store;
        this.#embedder = options.embedder;
        this.#llm = options.llm;
        this.#clock = options.clock;
        this.#rng = options.rng;
        this.#trace = options.trace;
        this.#persona = options.persona;
        this.#settings = options.settings;
        this.#alert = options.alert;
    }

    /** Digests conversations left open by a restart, and starts the nightly check. */
    start(): void {
        for (const channel of this.store.channelsWithOpenSegments()) this.#inBackground(this.closeSegment(channel));
        this.#scheduleNightly();
    }

    stop(): void {
        for (const cancel of this.#segmentTimers.values()) cancel();
        this.#segmentTimers.clear();
        this.#cancelNightly?.();
    }

    async whenIdle(): Promise<void> {
        while (this.#background.size > 0) await Promise.all(this.#background);
    }

    /** Reaches the raw log whether or not the agent ever reads it. */
    recordIncoming(message: ChatMessage): void {
        this.store.logMessage(message, userKey(message), false);
    }

    recordOwn(message: ChatMessage): void {
        this.store.logMessage(message, userKey(message), true);
    }

    markAttended(channel: string, messages: readonly ChatMessage[]): void {
        this.store.markAttended(
            channel,
            messages.map((message) => message.messageId),
        );
        if (this.store.openSegment(channel).length >= this.#settings.maxSegmentMessages) this.#inBackground(this.closeSegment(channel));
        else this.#scheduleSegmentClose(channel);
    }

    /** What the agent can still see of recent talk after a restart. */
    restoreWindow(channel: string, limit: number): ChatMessage[] {
        return this.store.recentAttended(channel, limit);
    }

    async recall(channel: string, newMessages: readonly ChatMessage[]): Promise<{ block: string; recalled: Recalled[] }> {
        const persona = this.#persona();
        const text = newMessages.map((message) => message.text).join(" ");
        const speakers = newMessages.map(userKey);
        const now = this.#clock.now();
        const vector = await this.#embedder.embed(text, "query");
        const recalled = selectMemories({
            memories: this.store.activeIn(channel),
            query: { text, speakers, vector },
            embedder: this.#embedder,
            now,
            forgetfulness: persona.forgetfulness,
            rng: this.#rng,
        });
        for (const { memory } of recalled) this.store.noteRecalled(memory.id, now, STRENGTH_GAIN, MAX_STRENGTH);
        this.#trace.record("memory.recall", {
            channel,
            detail: { recalled: recalled.map(({ memory, score, detailed }) => ({ id: memory.id, gist: memory.gist, score, detailed })) },
        });
        return { block: renderMemories(recalled, (key) => this.store.displayNameOf(key) ?? "someone"), recalled };
    }

    /** Digests a finished conversation. If the model fails, it stays open and is retried later. */
    async closeSegment(channel: string): Promise<void> {
        if (this.#closing.has(channel)) return;
        this.#closing.add(channel);
        try {
            await this.#digest(channel);
        } finally {
            this.#closing.delete(channel);
        }
    }

    async #digest(channel: string): Promise<void> {
        const messages = this.store.openSegment(channel);
        const ids = messages.map((message) => message.messageId);
        if (!messages.some((message) => !message.isSelf)) {
            this.store.markSegmented(channel, ids);
            return;
        }
        const persona = this.#persona();
        const result = await this.#llm.generate("extract", {
            stable: renderExtractionInstructions(persona),
            transcript: renderNumberedTranscript(messages, persona),
            volatile: "",
            schema: extractionSchema,
            maxOutput: EXTRACTION_MAX_OUTPUT,
            signal: new AbortController().signal,
        });
        if (result.kind !== "ok" || !result.data) {
            this.#alert("memory_extraction_failed", { channel, result: result.kind });
            return;
        }
        const written = await this.#write(channel, messages, result.data);
        this.store.markSegmented(channel, ids);
        this.#trace.record("memory.extracted", {
            channel,
            detail: { written, messages: messages.length, importance: clampUnit(result.data.importance), candidates: result.data.memories.length },
        });
    }

    async #write(channel: string, messages: readonly ChatMessage[], extraction: Extraction): Promise<number> {
        const now = this.#clock.now();
        // Anyone who opted out while the model was working is gone from the log, and so from these sources.
        const present = this.store.stillLogged(
            channel,
            messages.map((message) => message.messageId),
        );
        const live = messages.filter((message) => present.has(message.messageId));
        const participantOf = (message: ChatMessage): Participant => ({
            userKey: userKey(message),
            displayName: message.sender.displayName,
            isSelf: message.isSelf,
        });
        let written = 0;

        // Every real conversation leaves at least a faint episode. Everyday chat scores low, and low scores fade quickly.
        if (extraction.summary.trim() !== "" && live.some((message) => !message.isSelf)) {
            await this.#add({
                scope: channel,
                kind: "episode",
                subject: null,
                attributedTo: null,
                gist: extraction.summary.trim(),
                detail: "",
                importance: clampUnit(extraction.importance),
                salience: clampUnit(extraction.emotion),
                confidence: 1,
                sources: live.filter((message) => !message.isSelf).map((message) => ({ messageId: message.messageId, speaker: userKey(message) })),
                createdAt: now,
            });
            written++;
        }

        const startOfDay = now - DAY_MS;
        for (const candidate of extraction.memories) {
            if (clampUnit(candidate.importance) < MIN_KEPT_IMPORTANCE || candidate.gist.trim() === "") continue;
            const sourced = candidate.lines.flatMap((line) => {
                const message = messages[line - 1];
                return message && present.has(message.messageId) ? [message] : [];
            });
            const judgment = judgeCandidate(
                { about: candidate.about, gist: candidate.gist, detail: candidate.detail, isInstruction: candidate.isInstruction },
                sourced.map(participantOf),
            );
            if (!judgment) continue;
            const speakers = sourced.filter((message) => !message.isSelf).map(userKey);
            if (speakers.some((speaker) => this.store.writesSince(speaker, startOfDay) >= this.#settings.dailyWritesPerUser)) {
                this.#trace.record("memory.quota_exceeded", { channel, detail: { speakers } });
                continue;
            }
            await this.#add({
                scope: channel,
                ...judgment,
                gist: candidate.gist.trim(),
                detail: candidate.detail.trim(),
                importance: clampUnit(candidate.importance),
                salience: clampUnit(candidate.emotion),
                sources: sourced.map((message) => ({ messageId: message.messageId, speaker: userKey(message) })),
                createdAt: now,
            });
            written++;
        }
        return written;
    }

    async #add(draft: Omit<Parameters<MemoryStore["addMemory"]>[0], "embedding" | "embeddingModel">): Promise<void> {
        const embedding = await this.#embedder.embed(`${draft.gist} ${draft.detail}`, "passage");
        this.store.addMemory({ ...draft, embedding, embeddingModel: this.#embedder.modelId });
    }

    /** Removes everything derived from this person. Returns how many memories went. */
    forgetUser(user: string): number {
        const removed = this.store.forgetUser(user);
        this.#trace.record("memory.forget_user", { detail: { user, removed } });
        return removed;
    }

    /** Re-indexes changed text right away, so an edited memory doesn't drop out of recall until the nightly run. */
    edit(id: number, fields: { gist?: string; detail?: string; importance?: number }): void {
        this.store.edit(id, fields);
        const memory = this.store.get(id);
        if (memory && !memory.embedding) this.#inBackground(this.#reindex(memory.id, `${memory.gist} ${memory.detail}`));
    }

    async #reindex(id: number, text: string): Promise<void> {
        const embedding = await this.#embedder.embed(text, "passage");
        if (embedding && this.store.get(id)) this.store.setEmbedding(id, embedding, this.#embedder.modelId);
    }

    async consolidateNow(): Promise<ConsolidationReport> {
        const report = await consolidate({
            store: this.store,
            embedder: this.#embedder,
            llm: this.#llm,
            now: this.#clock.now(),
            rawRetentionMs: this.#settings.rawRetentionMs,
            signal: new AbortController().signal,
        });
        this.#trace.record("memory.consolidated", { detail: report });
        return report;
    }

    #scheduleSegmentClose(channel: string): void {
        this.#segmentTimers.get(channel)?.();
        this.#segmentTimers.set(
            channel,
            this.#clock.setTimer(this.#settings.segmentGapMs, () => {
                this.#segmentTimers.delete(channel);
                this.#inBackground(this.closeSegment(channel));
            }),
        );
    }

    #scheduleNightly(): void {
        this.#cancelNightly = this.#clock.setTimer(NIGHTLY_CHECK_MS, () => {
            this.#inBackground(this.#maybeConsolidate());
            this.#scheduleNightly();
        });
    }

    /** Runs once per local day, during the persona's scheduled sleep. */
    async #maybeConsolidate(): Promise<void> {
        const persona = this.#persona();
        const now = this.#clock.now();
        const today = localTime(now, persona.timezone).date;
        if (!isAsleep(persona, now) || this.store.getMeta(LAST_CONSOLIDATION_KEY) === today) return;
        this.store.setMeta(LAST_CONSOLIDATION_KEY, today);
        await this.consolidateNow();
    }

    #inBackground(work: Promise<unknown>): void {
        const tracked: Promise<unknown> = work
            .catch((error) => this.#alert("memory_failed", { error: String(error) }))
            .finally(() => this.#background.delete(tracked));
        this.#background.add(tracked);
    }
}

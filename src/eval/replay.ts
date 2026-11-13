import type { Clock } from "../lib/clock.ts";
import { costOf, type Prices } from "../lib/cost.ts";
import type { Rng } from "../lib/rng.ts";
import type { Usage } from "../llm/backend.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { MemoryStore, ReplayOutput, ReplyCapture } from "../memory/store.ts";
import { replySchema } from "../reply/prompt.ts";

/** What she actually said, which every candidate is compared against. */
export const ORIGINAL = "original";

const DAY_MS = 86_400_000;

export type Reply = { messages: string[]; image?: number | undefined };

/** One answer to a capture, from her or from a candidate. */
export type Entry = {
    name: string;
    model: string;
    result: ReplayOutput["result"];
    reply: Reply | undefined;
    usage: Usage | undefined;
    latencyMs: number | undefined;
};

export type Filter = {
    /** Which captures count. Only "reply" ones by default, since that's the model being replaced. */
    role?: string;
    /** Captures whose answer saw pictures are left out by default. Pictures aren't kept, so a candidate would only get their descriptions. */
    includePictures?: boolean;
};

export type RunOptions = Filter & {
    store: MemoryStore;
    llm: Pick<LlmRegistry, "generate" | "modelOf">;
    candidates: readonly string[];
    prices: Prices;
    clock: Clock;
    rng: Rng;
    /** The most captures to try this run. Ones every candidate already answered are skipped. */
    limit: number;
    /** Stops starting calls once this much is spent. Calls already running can take it slightly over. */
    maxUsd: number;
    concurrency?: number;
    onResult?: (output: ReplayOutput, spentUsd: number) => void;
};

export type RunSummary = { captures: number; calls: number; spentUsd: number; stoppedForBudget: boolean; unpriced: string[] };

function captures(store: MemoryStore, filter: Filter): ReplyCapture[] {
    const role = filter.role ?? "reply";
    return store.replyCaptures().filter((capture) => capture.role === role && (filter.includePictures || !capture.sawPictures));
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [result[i], result[j]] = [result[j] as T, result[i] as T];
    }
    return result;
}

/** An answer that errored is tried again next run. Refusals and truncations are results. */
function answered(store: MemoryStore): Set<string> {
    return new Set(store.replayOutputs().flatMap((output) => (output.result === "error" ? [] : [`${output.captureId}|${output.candidate}`])));
}

/** Every capture that still lacks an answer from some candidate, in random order, up to `limit`. */
export function pendingCaptures(options: Filter & { store: MemoryStore; candidates: readonly string[]; rng: Rng; limit: number }) {
    const done = answered(options.store);
    const pending = captures(options.store, options).flatMap((capture) => {
        const missing = options.candidates.filter((candidate) => !done.has(`${capture.id}|${candidate}`));
        return missing.length > 0 ? [{ capture, missing }] : [];
    });
    return shuffle(pending, options.rng).slice(0, options.limit);
}

/** Sends each capture, unchanged, to each candidate in place of the model that answered it. */
export async function runReplay(options: RunOptions): Promise<RunSummary> {
    const { store, llm, prices, clock } = options;
    const pending = pendingCaptures(options);
    const jobs = pending.flatMap(({ capture, missing }) => missing.map((candidate) => ({ capture, candidate })));
    const summary: RunSummary = { captures: pending.length, calls: 0, spentUsd: 0, stoppedForBudget: false, unpriced: [] };
    const unpriced = new Set<string>();
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            if (summary.spentUsd >= options.maxUsd) {
                summary.stoppedForBudget = true;
                return;
            }
            const job = jobs[next++];
            if (!job) return;
            const { capture, candidate } = job;
            const model = llm.modelOf(candidate) ?? "";
            const startedAt = clock.now();
            const result = await llm.generate(candidate, {
                stable: capture.stable,
                transcript: capture.transcript,
                volatile: capture.volatile,
                schema: replySchema,
                maxOutput: capture.maxOutput,
                signal: new AbortController().signal,
            });
            const usage = result.kind === "error" ? undefined : result.usage;
            const price = prices[model];
            if (usage && !price) unpriced.add(model);
            summary.spentUsd += usage && price ? costOf(usage, price) : 0;
            summary.calls++;
            const output: ReplayOutput = {
                captureId: capture.id,
                candidate,
                model,
                result: result.kind,
                output: result.kind === "ok" ? result.data : undefined,
                usage,
                latencyMs: clock.now() - startedAt,
                ranAt: clock.now(),
            };
            store.saveReplayOutput(output);
            options.onResult?.(output, summary.spentUsd);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
    summary.unpriced = [...unpriced];
    return summary;
}

function toReply(output: unknown): Reply | undefined {
    const parsed = replySchema.safeParse(output);
    return parsed.success ? parsed.data : undefined;
}

/** Her own answer first, then each candidate's. */
export function entriesOf(capture: ReplyCapture, outputs: readonly ReplayOutput[]): Entry[] {
    const original: Entry = {
        name: ORIGINAL,
        model: capture.model,
        result: "ok",
        reply: toReply(capture.output),
        usage: capture.usage,
        latencyMs: undefined,
    };
    const replayed = outputs
        .filter((output) => output.captureId === capture.id)
        .map((output) => ({
            name: output.candidate,
            model: output.model,
            result: output.result,
            reply: toReply(output.output),
            usage: output.usage,
            latencyMs: output.latencyMs,
        }));
    return [original, ...replayed];
}

export type Pair = { capture: ReplyCapture; first: Entry; second: Entry };

/**
 * An unrated pair of answers to the same capture, in random order so the rater can't tell which is which.
 * Without `pairs`, each candidate is set against what she actually said.
 */
export function nextPair(options: Filter & { store: MemoryStore; rng: Rng; pairs?: readonly (readonly [string, string])[] }): Pair | undefined {
    const { store, rng } = options;
    const outputs = store.replayOutputs();
    const rated = new Set(store.replayRatings().map((rating) => pairKey(rating.captureId, rating.first, rating.second)));
    for (const capture of shuffle(captures(store, options), rng)) {
        const entries = new Map(entriesOf(capture, outputs).flatMap((entry) => (entry.result === "ok" && entry.reply ? [[entry.name, entry]] : [])));
        const pairs = options.pairs ?? [...entries.keys()].filter((name) => name !== ORIGINAL).map((name) => [ORIGINAL, name] as const);
        for (const [a, b] of shuffle(pairs, rng)) {
            const first = entries.get(a);
            const second = entries.get(b);
            if (!first || !second || rated.has(pairKey(capture.id, a, b))) continue;
            return rng.chance(0.5) ? { capture, first, second } : { capture, first: second, second: first };
        }
    }
    return undefined;
}

function pairKey(captureId: number, a: string, b: string): string {
    return [captureId, ...[a, b].sort()].join("|");
}

export type EntrantStats = {
    name: string;
    models: string[];
    answers: number;
    failed: number;
    silent: number;
    avgMessages: number;
    avgChars: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgCostUsd: number;
    /** Roughly what this would cost a day as the reply model, from how many replies she was captured making a day. */
    perDayUsd: number;
    medianLatencyMs: number | undefined;
};

export type HeadToHead = { a: string; b: string; aWins: number; bWins: number; ties: number };

export type Report = { captures: number; replayed: number; repliesPerDay: number; entrants: EntrantStats[]; headToHead: HeadToHead[] };

function average(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/** Compares everyone over the same captures: only ones some candidate has answered. */
export function replayReport(options: Filter & { store: MemoryStore; prices: Prices }): Report {
    const { store, prices } = options;
    const all = captures(store, options);
    const outputs = store.replayOutputs();
    const replayedIds = new Set(outputs.map((output) => output.captureId));
    const replayed = all.filter((capture) => replayedIds.has(capture.id));
    // Every reply she made counts toward how often she replies, pictures or not.
    const made = captures(store, { ...options, includePictures: true });
    const times = made.map((capture) => capture.capturedAt);
    const spanDays = times.length === 0 ? 1 : Math.max(1, (Math.max(...times) - Math.min(...times)) / DAY_MS);
    const repliesPerDay = made.length / spanDays;

    const byName = new Map<string, Entry[]>();
    for (const capture of replayed) {
        for (const entry of entriesOf(capture, outputs)) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    }
    const entrants = [...byName].map(([name, entries]): EntrantStats => {
        const ok = entries.filter((entry) => entry.result === "ok" && entry.reply);
        const replies = ok.flatMap((entry) => (entry.reply ? [entry.reply] : []));
        const priced = entries.flatMap((entry) => {
            const price = prices[entry.model];
            return entry.usage && price ? [costOf(entry.usage, price)] : [];
        });
        const avgCostUsd = average(priced);
        return {
            name,
            models: [...new Set(entries.map((entry) => entry.model))],
            answers: entries.length,
            failed: entries.length - ok.length,
            silent: replies.filter((reply) => reply.messages.length === 0 && reply.image === undefined).length,
            avgMessages: average(replies.map((reply) => reply.messages.length)),
            avgChars: average(replies.map((reply) => reply.messages.join("").length)),
            avgInputTokens: average(entries.flatMap((entry) => (entry.usage ? [entry.usage.inputTokens + entry.usage.cachedInputTokens] : []))),
            avgOutputTokens: average(entries.flatMap((entry) => (entry.usage ? [entry.usage.outputTokens] : []))),
            avgCostUsd,
            perDayUsd: avgCostUsd * repliesPerDay,
            medianLatencyMs: median(entries.flatMap((entry) => (entry.latencyMs === undefined ? [] : [entry.latencyMs]))),
        };
    });

    const kept = new Set(all.map((capture) => capture.id));
    const tallies = new Map<string, HeadToHead>();
    for (const rating of store.replayRatings()) {
        if (!kept.has(rating.captureId)) continue;
        const [a, b] = [rating.first, rating.second].sort() as [string, string];
        const tally = tallies.get(`${a}|${b}`) ?? { a, b, aWins: 0, bWins: 0, ties: 0 };
        if (rating.winner === a) tally.aWins++;
        else if (rating.winner === b) tally.bWins++;
        else tally.ties++;
        tallies.set(`${a}|${b}`, tally);
    }
    return { captures: all.length, replayed: replayed.length, repliesPerDay, entrants, headToHead: [...tallies.values()] };
}

/** The chat part of a captured transcript, without the memories and people above it. */
export function chatOf(transcript: string): string[] {
    const chat = /<chat>\n([\s\S]*)\n<\/chat>/.exec(transcript)?.[1];
    return chat === undefined ? transcript.split("\n") : chat.split("\n");
}

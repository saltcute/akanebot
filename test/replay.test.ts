import { describe, expect, it } from "vitest";
import { nextPair, ORIGINAL, pendingCaptures, replayReport, runReplay } from "../src/eval/replay.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { Rng } from "../src/lib/rng.ts";
import type { LlmResult } from "../src/llm/backend.ts";
import { FakeBackend, type FakeResponder } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";
import { MemoryStore, type ReplyCaptureDraft } from "../src/memory/store.ts";

const DAY_MS = 86_400_000;
const PRICES = { big: { input: 4, cachedInput: 0.2, output: 20 }, small: { input: 0.1, cachedInput: 0.01, output: 0.5 } };
const USAGE = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 };

function draft(overrides: Partial<ReplyCaptureDraft> = {}): ReplyCaptureDraft {
    return {
        channel: "qq:1",
        messageId: "m1",
        capturedAt: 0,
        role: "reply",
        model: "big",
        stable: "instructions",
        transcript: "<people>\nbob\n</people>\n<chat>\nbob: 在吗\n</chat>",
        volatile: "state",
        maxOutput: 2000,
        sawPictures: false,
        output: { messages: ["在"] },
        usage: USAGE,
        refs: { messages: ["m1"], users: ["qq:bob"], memories: [], images: [] },
        ...overrides,
    };
}

function candidates(respond: Record<string, FakeResponder>) {
    const backends = Object.fromEntries(Object.entries(respond).map(([name, responder]) => [name, new FakeBackend(responder)]));
    const llm = new LlmRegistry(
        llmConfigSchema.parse({
            backends: Object.fromEntries(Object.keys(respond).map((name) => [name, { type: name }])),
            roles: Object.fromEntries(Object.keys(respond).map((name) => [name, { backend: name, model: "small" }])),
        }),
        Object.fromEntries(Object.entries(backends).map(([name, backend]) => [name, () => backend])),
    );
    return { llm, backends };
}

const ok = (messages: string[]): LlmResult<unknown> => ({ kind: "ok", text: "", data: { messages }, usage: USAGE });

describe("reply captures in the store", () => {
    it("go with a memory, a saved picture or a person they show", () => {
        const store = new MemoryStore(":memory:");
        const memory = store.addMemory({
            scope: "qq:1",
            kind: "fact",
            subject: "qq:carol",
            attributedTo: "qq:carol",
            gist: "carol 养猫",
            detail: "",
            importance: 0.5,
            salience: 0.5,
            confidence: 0.5,
            embedding: undefined,
            embeddingModel: null,
            sources: [],
            createdAt: 0,
        });
        const image = store.saveImage({
            sha256: "abc",
            scope: "qq:1",
            messageId: "img",
            userKey: "qq:dave",
            mime: "image/png",
            bytes: new Uint8Array([1]),
            description: "猫",
            useFor: "",
            appeal: 1,
            embedding: undefined,
            embeddingModel: null,
            savedAt: 0,
        });
        store.captureReply(draft({ refs: { messages: [], users: [], memories: [memory], images: [] } }));
        store.captureReply(draft({ refs: { messages: [], users: [], memories: [], images: [image ?? 0] } }));
        store.captureReply(draft({ refs: { messages: [], users: ["qq:erin"], memories: [], images: [] } }));
        store.forget(memory);
        expect(store.replyCaptures()).toHaveLength(2);
        store.deleteSavedImage(image ?? 0);
        expect(store.replyCaptures()).toHaveLength(1);
        store.forgetUser("qq:erin");
        expect(store.replyCaptures()).toEqual([]);
    });

    it("take their answers and ratings with them", () => {
        const store = new MemoryStore(":memory:");
        const id = store.captureReply(draft());
        store.saveReplayOutput({ captureId: id, candidate: "c", model: "small", result: "ok", output: {}, usage: USAGE, latencyMs: 1, ranAt: 0 });
        store.saveReplayRating({ captureId: id, first: ORIGINAL, second: "c", winner: "tie", ratedAt: 0 });
        store.deleteLogged("qq:1", "m1");
        expect(store.replayOutputs()).toEqual([]);
        expect(store.replayRatings()).toEqual([]);
    });

    it("are kept no longer than the raw log", () => {
        const store = new MemoryStore(":memory:");
        store.captureReply(draft({ capturedAt: 0 }));
        store.captureReply(draft({ capturedAt: 2 * DAY_MS }));
        store.purgeRawBefore(DAY_MS);
        expect(store.replyCaptures().map((capture) => capture.capturedAt)).toEqual([2 * DAY_MS]);
    });
});

describe("runReplay", () => {
    it("sends each capture unchanged to each candidate and keeps the answers", async () => {
        const store = new MemoryStore(":memory:");
        store.captureReply(draft());
        const { llm, backends } = candidates({ a: () => ok(["a 的回复"]), b: () => ok([]) });
        const summary = await runReplay({
            store,
            llm,
            candidates: ["a", "b"],
            prices: PRICES,
            clock: new ManualClock(),
            rng: new Rng(1),
            limit: 10,
            maxUsd: 1,
        });
        expect(summary).toMatchObject({ captures: 1, calls: 2, stoppedForBudget: false });
        expect(backends.a?.calls[0]).toMatchObject({ stable: "instructions", volatile: "state", maxOutput: 2000 });
        expect(backends.a?.calls[0]?.transcript).toContain("bob: 在吗");
        expect(store.replayOutputs().map((output) => [output.candidate, output.output])).toEqual([
            ["a", { messages: ["a 的回复"] }],
            ["b", { messages: [] }],
        ]);
        expect(pendingCaptures({ store, candidates: ["a", "b"], rng: new Rng(1), limit: 10 })).toEqual([]);
    });

    it("leaves out replies that saw pictures unless asked, and tries errors again", async () => {
        const store = new MemoryStore(":memory:");
        store.captureReply(draft({ sawPictures: true }));
        const text = store.captureReply(draft());
        store.saveReplayOutput({
            captureId: text,
            candidate: "a",
            model: "small",
            result: "error",
            output: undefined,
            usage: undefined,
            latencyMs: 1,
            ranAt: 0,
        });
        const pending = pendingCaptures({ store, candidates: ["a"], rng: new Rng(1), limit: 10 });
        expect(pending.map(({ capture }) => capture.id)).toEqual([text]);
        expect(pendingCaptures({ store, candidates: ["a"], rng: new Rng(1), limit: 10, includePictures: true })).toHaveLength(2);
    });

    it("stops starting calls once the cap is spent", async () => {
        const store = new MemoryStore(":memory:");
        for (let i = 0; i < 5; i++) store.captureReply(draft({ messageId: `m${i}` }));
        const { llm } = candidates({
            a: () => ({ kind: "ok", text: "", data: { messages: ["x"] }, usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 } }),
        });
        const summary = await runReplay({
            store,
            llm,
            candidates: ["a"],
            prices: PRICES,
            clock: new ManualClock(),
            rng: new Rng(1),
            limit: 10,
            maxUsd: 0.15,
        });
        expect(summary).toMatchObject({ calls: 2, stoppedForBudget: true });
    });
});

describe("rating and reporting", () => {
    function replayed() {
        const store = new MemoryStore(":memory:");
        for (let i = 0; i < 4; i++) {
            const id = store.captureReply(draft({ messageId: `m${i}`, capturedAt: i * DAY_MS }));
            store.saveReplayOutput({
                captureId: id,
                candidate: "a",
                model: "small",
                result: "ok",
                output: { messages: [] },
                usage: USAGE,
                latencyMs: 500,
                ranAt: 0,
            });
        }
        return store;
    }

    it("offers each unrated pair once, in either order", () => {
        const store = replayed();
        const rng = new Rng(3);
        const orders = new Set<string>();
        for (let i = 0; i < 4; i++) {
            const pair = nextPair({ store, rng });
            expect(pair).toBeDefined();
            if (!pair) return;
            orders.add(pair.first.name);
            store.saveReplayRating({ captureId: pair.capture.id, first: pair.first.name, second: pair.second.name, winner: ORIGINAL, ratedAt: 0 });
        }
        expect(nextPair({ store, rng })).toBeUndefined();
        expect(orders).toEqual(new Set([ORIGINAL, "a"]));
    });

    it("compares cost, silence and wins over the same captures", () => {
        const store = replayed();
        const [first, second] = store.replyCaptures();
        store.saveReplayRating({ captureId: first?.id ?? 0, first: "a", second: ORIGINAL, winner: ORIGINAL, ratedAt: 0 });
        store.saveReplayRating({ captureId: second?.id ?? 0, first: ORIGINAL, second: "a", winner: "tie", ratedAt: 0 });
        const report = replayReport({ store, prices: PRICES });
        expect(report).toMatchObject({ captures: 4, replayed: 4 });
        expect(report.repliesPerDay).toBeCloseTo(4 / 3);
        const original = report.entrants.find((entrant) => entrant.name === ORIGINAL);
        const a = report.entrants.find((entrant) => entrant.name === "a");
        expect(original?.avgCostUsd).toBeCloseTo(0.006);
        expect(a).toMatchObject({ answers: 4, failed: 0, silent: 4, medianLatencyMs: 500 });
        expect(a?.avgCostUsd).toBeCloseTo(0.00015);
        expect(report.headToHead).toEqual([{ a: "a", b: ORIGINAL, aWins: 0, bWins: 1, ties: 1 }]);
    });
});

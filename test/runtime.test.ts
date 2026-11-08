import { describe, expect, it } from "vitest";
import { CliAdapter } from "../src/adapters/cli.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { DecisionTrace } from "../src/lib/trace.ts";
import type { LlmResult } from "../src/llm/backend.ts";
import { FakeBackend, type FakeResponder } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";
import { Runtime } from "../src/runtime.ts";

async function setup(respond: FakeResponder) {
    const clock = new ManualClock();
    const trace = new DecisionTrace(clock);
    const adapter = new CliAdapter({ clock, selfName: "gabriel" });
    const backend = new FakeBackend(respond);
    const llm = new LlmRegistry(llmConfigSchema.parse({ backends: { f: { type: "fake" } }, roles: { reply: { backend: "f", model: "scripted" } } }), {
        fake: () => backend,
    });
    const runtime = new Runtime({
        clock,
        trace,
        llm,
        adapters: [adapter],
        timing: { quietMs: 1000, maxWaitMs: 5000, candidateTtlMs: 60_000, windowSize: 40 },
        limits: { bucketCapacity: 10, refillPerMinute: 6, shareWindow: 20, maxShare: 0.9, minShareSample: 5 },
    });
    await runtime.start();
    return { clock, trace, adapter, backend, runtime };
}

describe("Runtime", () => {
    it("takes a message from the group through to a sent reply", async () => {
        const { clock, adapter, backend, runtime } = await setup(() => "哈哈");
        adapter.say("alice", "今天好冷");
        await clock.advance(1000);
        await runtime.body.whenIdle();
        expect(adapter.sent.map((s) => s.text)).toEqual(["哈哈"]);
        expect(backend.calls[0]?.transcript).toBe("alice: 今天好冷");
    });

    it("does not react to the echo of its own message", async () => {
        const { clock, adapter, backend, runtime } = await setup(() => "哈哈");
        adapter.say("alice", "hi");
        await clock.advance(1000);
        await runtime.body.whenIdle();
        await clock.advance(10_000);
        await runtime.body.whenIdle();
        expect(backend.calls).toHaveLength(1);
        expect(adapter.sent).toHaveLength(1);
    });

    it("shows its own earlier replies in the next transcript, once each", async () => {
        const { clock, adapter, backend, runtime } = await setup(() => "嗯");
        adapter.say("alice", "one");
        await clock.advance(1000);
        await runtime.body.whenIdle();
        adapter.say("alice", "two");
        await clock.advance(1000);
        await runtime.body.whenIdle();
        expect(backend.calls[1]?.transcript).toBe("alice: one\nme: 嗯\nalice: two");
    });

    it("stays silent in chat on every kind of failure", async () => {
        const failures: LlmResult<unknown>[] = [
            { kind: "error", retryable: false },
            { kind: "refused", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
            { kind: "truncated", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
            { kind: "ok", text: "   ", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
        ];
        const queue = [...failures];
        const { clock, adapter, trace, runtime } = await setup(() => queue.shift() ?? "unexpected");
        for (const failure of failures) {
            adapter.say("alice", `after ${failure.kind}`);
            await clock.advance(1000);
            await runtime.body.whenIdle();
        }
        expect(adapter.sent).toEqual([]);
        expect(trace.ofKind("reply.silent")).toHaveLength(failures.length);
    });

    it("does not reply while away, and picks up on return if still fresh", async () => {
        const { clock, adapter, runtime } = await setup(() => "嗯");
        runtime.body.goAway();
        adapter.say("alice", "hello?");
        await clock.advance(5000);
        await runtime.body.whenIdle();
        expect(adapter.sent).toEqual([]);
        runtime.body.comeBack();
        await runtime.body.whenIdle();
        expect(adapter.sent).toHaveLength(1);
    });

    it("forgets the offer if it comes back too late", async () => {
        const { clock, adapter, runtime } = await setup(() => "嗯");
        runtime.body.goAway();
        adapter.say("alice", "hello?");
        await clock.advance(120_000);
        runtime.body.comeBack();
        await runtime.body.whenIdle();
        expect(adapter.sent).toEqual([]);
    });
});

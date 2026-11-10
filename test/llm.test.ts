import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmResult } from "../src/llm/backend.ts";
import { FakeBackend, type FakeResponse } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";

const signal = new AbortController().signal;
const request = { stable: "s", transcript: "t", volatile: "v", maxOutput: 10, signal };

function registry(primary: readonly FakeResponse[], fallback: readonly FakeResponse[] = [], withFallback = false) {
    const backends = { primary: new FakeBackend(primary), secondary: new FakeBackend(fallback) };
    const usage: string[] = [];
    const llm = new LlmRegistry(
        llmConfigSchema.parse({
            backends: { a: { type: "primary" }, b: { type: "secondary" } },
            roles: {
                reply: {
                    backend: "a",
                    model: "model-a",
                    options: { effort: "low" },
                    ...(withFallback ? { fallback: { backend: "b", model: "model-b" } } : {}),
                },
            },
        }),
        { primary: () => backends.primary, secondary: () => backends.secondary },
        (_usage, role, model) => usage.push(`${role}/${model}`),
    );
    return { llm, backends, usage };
}

describe("FakeBackend", () => {
    it("validates structured responses against the schema", async () => {
        const schema = z.object({ speak: z.boolean() });
        const backend = new FakeBackend(['{"speak":true}', '{"speak":"maybe"}', "not json"]);
        const req = { ...request, options: {}, schema };
        await expect(backend.generate(req)).resolves.toMatchObject({ kind: "ok", data: { speak: true } });
        await expect(backend.generate(req)).resolves.toMatchObject({ kind: "error" });
        await expect(backend.generate(req)).resolves.toMatchObject({ kind: "error" });
    });

    it("records calls", async () => {
        const backend = new FakeBackend(["x"]);
        await backend.generate({ ...request, options: {} });
        expect(backend.calls[0]?.transcript).toBe("t");
    });
});

describe("LlmRegistry", () => {
    it("passes role options through to the backend untouched", async () => {
        const { llm, backends } = registry(["hello"]);
        await llm.generate("reply", request);
        expect(backends.primary.calls[0]?.options).toEqual({ effort: "low" });
    });

    it("rejects an unknown role", async () => {
        const { llm } = registry(["x"]);
        await expect(llm.generate("nope", request)).rejects.toThrow(/nope/);
    });

    it("falls back when the primary errors", async () => {
        const error: LlmResult<unknown> = { kind: "error", retryable: true };
        const { llm, backends, usage } = registry([error], ["from fallback"], true);
        await expect(llm.generate("reply", request)).resolves.toMatchObject({ kind: "ok", text: "from fallback" });
        expect(backends.secondary.calls).toHaveLength(1);
        expect(usage).toEqual(["reply/model-b"]);
    });

    it("does not fall back on a refusal", async () => {
        const refused: LlmResult<unknown> = { kind: "refused", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 } };
        const { llm, backends } = registry([refused], ["from fallback"], true);
        await expect(llm.generate("reply", request)).resolves.toMatchObject({ kind: "refused" });
        expect(backends.secondary.calls).toHaveLength(0);
    });

    it("does not fall back after the lease was aborted", async () => {
        const error: LlmResult<unknown> = { kind: "error", retryable: true };
        const { llm, backends } = registry([error], ["from fallback"], true);
        const controller = new AbortController();
        controller.abort();
        await llm.generate("reply", { ...request, signal: controller.signal });
        expect(backends.secondary.calls).toHaveLength(0);
    });

    it("says a role can see only if every model that might answer can", () => {
        const blind = () => new FakeBackend(() => "x", { vision: false });
        const sighted = () => new FakeBackend(() => "x");
        const roles = {
            both: { backend: "a", model: "m", fallback: { backend: "a", model: "m" } },
            fallbackBlind: { backend: "a", model: "m", fallback: { backend: "b", model: "m" } },
            blind: { backend: "b", model: "m" },
        };
        const llm = new LlmRegistry(llmConfigSchema.parse({ backends: { a: { type: "sighted" }, b: { type: "blind" } }, roles }), { sighted, blind });
        expect(llm.canSee("both")).toBe(true);
        expect(llm.canSee("fallbackBlind")).toBe(false);
        expect(llm.canSee("blind")).toBe(false);
        expect(llm.canSee("missing")).toBe(false);
    });

    it("reuses one backend instance per backend and model", async () => {
        let created = 0;
        const llm = new LlmRegistry(llmConfigSchema.parse({ backends: { a: { type: "t" } }, roles: { reply: { backend: "a", model: "m" } } }), {
            t: () => {
                created++;
                return new FakeBackend(() => "x");
            },
        });
        await llm.generate("reply", request);
        await llm.generate("reply", request);
        expect(created).toBe(1);
    });
});

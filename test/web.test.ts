import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CliAdapter } from "../src/adapters/cli.ts";
import { MemoryControlStore } from "../src/control/state.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { CostMeter } from "../src/lib/cost.ts";
import { Rng } from "../src/lib/rng.ts";
import { DecisionTrace } from "../src/lib/trace.ts";
import { NullEmbedder } from "../src/llm/embedder.ts";
import { FakeBackend } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";
import { type MemoryDraft, MemoryStore } from "../src/memory/store.ts";
import { Runtime } from "../src/runtime.ts";
import { isLoopback, resolveWebToken, WebServer } from "../src/web/server.ts";
import { PERSONA } from "./fixtures.ts";

const TOKEN = "correct-horse-battery-staple";
const CHANNEL = "cli:group";
const CHANNEL_PATH = encodeURIComponent(CHANNEL);
const ROLES = ["gate", "reply", "technical", "vision", "extract", "consolidate"];
const EXTRACTION = JSON.stringify({ summary: "they talked about noodles", importance: 0.8, emotion: 0.2, memories: [] });

const running: WebServer[] = [];

afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.stop()));
});

function draft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
    return {
        scope: CHANNEL,
        kind: "fact",
        subject: "cli:alice",
        attributedTo: null,
        gist: "alice likes noodles",
        detail: "especially the spicy ones",
        importance: 0.5,
        salience: 0.5,
        confidence: 0.9,
        embedding: new Float32Array([1, 0]),
        embeddingModel: "test-model",
        sources: [{ messageId: "m1", speaker: "cli:alice" }],
        createdAt: 1000,
        ...overrides,
    };
}

async function setup() {
    const clock = new ManualClock(1_000_000);
    const trace = new DecisionTrace(clock);
    const adapter = new CliAdapter({ clock, selfName: PERSONA.name });
    const store = new MemoryStore(":memory:");
    const llm = new LlmRegistry(
        llmConfigSchema.parse({
            backends: { fake: { type: "fake" } },
            roles: Object.fromEntries(ROLES.map((role) => [role, { backend: "fake", model: role }])),
        }),
        { fake: () => new FakeBackend(() => EXTRACTION) },
    );
    const runtime = new Runtime({
        clock,
        rng: new Rng(1),
        trace,
        llm,
        cost: new CostMeter({ clock, prices: {}, dailyBudgetUsd: 2 }),
        persona: PERSONA,
        adapters: [adapter],
        timing: { quietMs: 1000, maxWaitMs: 5000, candidateTtlMs: 60_000, windowSize: 40 },
        limits: { bucketCapacity: 10, refillPerMinute: 6, shareWindow: 20, maxShare: 0.4, minShareSample: 5 },
        control: {
            commandPrefix: "/akanebot",
            admins: [],
            groups: [{ platform: "cli", channelId: "group", disclosed: true }],
        },
        controlStore: new MemoryControlStore(),
        memoryStore: store,
        embedder: new NullEmbedder(),
        memorySettings: { segmentGapMs: 60_000, maxSegmentMessages: 60, rawRetentionMs: 86_400_000, dailyWritesPerUser: 30 },
    });
    await runtime.start();
    const errors: string[] = [];
    const server = new WebServer({ runtime, token: TOKEN, host: "127.0.0.1", port: 0, onError: (message) => errors.push(message) });
    running.push(server);
    const base = (await server.start()).replace(/\/$/, "");
    const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
        fetch(`${base}${path}`, {
            ...init,
            headers: {
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                ...(init.body ? { "content-type": "application/json" } : {}),
            },
        });
    const json = async (path: string, init: RequestInit = {}) => {
        const response = await call(path, init);
        expect(response.status).toBe(200);
        // biome-ignore lint/suspicious/noExplicitAny: responses are checked field by field below
        return (await response.json()) as any;
    };
    const post = (path: string, body?: unknown) => json(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { adapter, store, runtime, base, call, json, post, errors, trace };
}

describe("web console access", () => {
    it("refuses every API route without the right token", async () => {
        const { call } = await setup();
        expect((await call("/api/status", {}, null)).status).toBe(401);
        expect((await call("/api/memories", {}, "wrong")).status).toBe(401);
        expect((await call("/api/control/kill", { method: "POST" }, null)).status).toBe(401);
    });

    it("serves the page without a token, but with a strict content policy", async () => {
        const { base } = await setup();
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(200);
        const policy = page.headers.get("content-security-policy") ?? "";
        expect(policy).toContain("default-src 'none'");
        expect(policy).toContain("script-src 'self'");
        expect(policy).not.toContain("unsafe-inline");
        expect((await fetch(`${base}/app.js`)).status).toBe(200);
    });

    it("serves only the known files", async () => {
        const { base } = await setup();
        expect((await fetch(`${base}/server.ts`)).status).toBe(404);
        expect((await fetch(`${base}/..%2fserver.ts`)).status).toBe(404);
        expect((await fetch(`${base}/public/app.js`)).status).toBe(404);
    });

    it("never builds markup from strings in the browser", () => {
        const source = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
        expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    });

    it("makes up a token when none is set, and rejects a weak one", () => {
        expect(resolveWebToken(undefined).generated).toBe(true);
        expect(resolveWebToken(undefined).token.length).toBeGreaterThanOrEqual(32);
        expect(resolveWebToken(TOKEN)).toEqual({ token: TOKEN, generated: false });
        expect(() => resolveWebToken("short")).toThrow(/at least/);
    });

    it("knows which hosts stay on this machine", () => {
        expect(isLoopback("127.0.0.1")).toBe(true);
        expect(isLoopback("localhost")).toBe(true);
        expect(isLoopback("0.0.0.0")).toBe(false);
    });

    it("reports bad input without treating it as a server fault", async () => {
        const { call, errors } = await setup();
        expect((await call(`/api/conversations/${CHANNEL_PATH}/mute`, { method: "POST", body: "{not json" })).status).toBe(400);
        expect((await call(`/api/conversations/${CHANNEL_PATH}/mute`, { method: "POST", body: JSON.stringify({ minutes: -1 }) })).status).toBe(400);
        expect((await call("/api/conversations/%E0%A4%A")).status).toBe(400);
        expect(errors).toEqual([]);
    });
});

describe("web console conversations", () => {
    it("lists allowed channels even before anyone has spoken", async () => {
        const { json } = await setup();
        const { conversations } = await json("/api/conversations");
        expect(conversations).toHaveLength(1);
        expect(conversations[0]).toMatchObject({ key: CHANNEL, unread: 0 });
        expect(conversations[0].lastMessage).toBeUndefined();
    });

    it("shows the live window and what is unread", async () => {
        const { adapter, json } = await setup();
        adapter.say("alice", "<img src=x onerror=alert(1)>");
        const detail = await json(`/api/conversations/${CHANNEL_PATH}`);
        expect(detail.unread).toBe(1);
        expect(detail.firstNewIndex).toBe(0);
        expect(detail.messages[0]).toMatchObject({ senderName: "alice", senderKey: "cli:alice", text: "<img src=x onerror=alert(1)>" });
    });

    it("won't touch a channel outside the allowlist", async () => {
        const { call } = await setup();
        expect((await call("/api/conversations/discord%3A999")).status).toBe(404);
        expect((await call("/api/conversations/discord%3A999/mute", { method: "POST", body: JSON.stringify({ minutes: 5 }) })).status).toBe(404);
    });

    it("mutes and unmutes", async () => {
        const { json, post } = await setup();
        await post(`/api/conversations/${CHANNEL_PATH}/mute`, { minutes: 30 });
        expect((await json(`/api/conversations/${CHANNEL_PATH}`)).mutedUntil).toBe(1_000_000 + 30 * 60_000);
        await post(`/api/conversations/${CHANNEL_PATH}/unmute`);
        expect((await json(`/api/conversations/${CHANNEL_PATH}`)).mutedUntil).toBeUndefined();
    });

    it("lets go of unread messages without removing them", async () => {
        const { adapter, json, post } = await setup();
        adapter.say("alice", "anyone here");
        await post(`/api/conversations/${CHANNEL_PATH}/read`);
        const detail = await json(`/api/conversations/${CHANNEL_PATH}`);
        expect(detail.unread).toBe(0);
        expect(detail.messages).toHaveLength(1);
    });

    it("digests what she has read into memories on request", async () => {
        const { adapter, runtime, json, post } = await setup();
        const id = adapter.say("alice", "noodles are great");
        const [message] = runtime.conversation(CHANNEL)?.messages ?? [];
        expect(message?.messageId).toBe(id);
        runtime.memory.store.markAttended(CHANNEL, [id]);
        expect((await json(`/api/conversations/${CHANNEL_PATH}`)).undigested).toBe(1);
        expect(await post(`/api/conversations/${CHANNEL_PATH}/digest`)).toEqual({ undigested: 0 });
        expect((await json("/api/memories")).memories[0].gist).toBe("they talked about noodles");
    });

    it("stops and resumes everywhere, and survives in the status", async () => {
        const { json, post, runtime } = await setup();
        await post("/api/control/kill");
        expect(await json("/api/status")).toMatchObject({ killed: true, body: "away", awayReasons: ["kill"] });
        await post("/api/control/resume");
        expect(runtime.status()).toMatchObject({ killed: false, awayReasons: [] });
    });

    it("shows decisions about a message, and recent alerts", async () => {
        const { adapter, json, trace } = await setup();
        const id = adapter.say("alice", "hello");
        trace.record("alert", { detail: { reason: "something_broke" } });
        const { decisions } = await json(`/api/messages/${id}/decisions`);
        expect(decisions.map((event: { kind: string }) => event.kind)).toContain("message.observed");
        expect((await json("/api/status")).alerts[0].detail.reason).toBe("something_broke");
    });
});

describe("web console memories", () => {
    it("filters, searches and pages", async () => {
        const { store, json } = await setup();
        store.addMemory(draft());
        store.addMemory(draft({ kind: "claim", gist: "bob says 100% of cats are evil", createdAt: 2000 }));
        const archived = store.addMemory(draft({ gist: "old news", createdAt: 3000 }));
        store.setStatus(archived, "archived");

        expect((await json("/api/memories")).total).toBe(3);
        expect((await json("/api/memories?state=active")).total).toBe(2);
        expect((await json("/api/memories?state=archived")).memories[0].gist).toBe("old news");
        expect((await json("/api/memories?kind=claim")).total).toBe(1);
        expect((await json("/api/memories?q=spicy")).total).toBe(3);
        expect((await json(`/api/memories?q=${encodeURIComponent("100%")}`)).total).toBe(1);
        expect((await json(`/api/memories?q=${encodeURIComponent("%")}`)).total).toBe(1);
        const page = await json("/api/memories?limit=1&offset=1");
        expect(page.total).toBe(3);
        expect(page.memories).toHaveLength(1);
        expect(page.memories[0].createdAt).toBe(2000);
    });

    it("never sends embeddings to the browser", async () => {
        const { store, json } = await setup();
        const id = store.addMemory(draft());
        const memory = await json(`/api/memories/${id}`);
        expect(memory.embedding).toBeUndefined();
        expect(memory.indexed).toBe(true);
    });

    it("shows where a memory came from, even after the message has expired", async () => {
        const { adapter, store, json } = await setup();
        const message = adapter.say("alice", "i love noodles");
        const id = store.addMemory(
            draft({
                sources: [
                    { messageId: message, speaker: "cli:alice" },
                    { messageId: "gone", speaker: "cli:alice" },
                ],
            }),
        );
        const { sources } = await json(`/api/memories/${id}`);
        expect(sources.find((source: { messageId: string }) => source.messageId === message)).toMatchObject({
            displayName: "alice",
            text: "i love noodles",
        });
        expect(sources.find((source: { messageId: string }) => source.messageId === "gone")).toMatchObject({ text: null, sentAt: null });
    });

    it("edits text and importance, but leaves confidence and provenance alone", async () => {
        const { store, json } = await setup();
        const id = store.addMemory(draft());
        await json(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify({ gist: "alice hates noodles", detail: "", importance: 0.9 }) });
        expect(store.get(id)).toMatchObject({
            gist: "alice hates noodles",
            detail: "",
            importance: 0.9,
            confidence: 0.9,
            subject: "cli:alice",
            kind: "fact",
        });
        expect(store.get(id)?.embedding).toBeUndefined();
    });

    it("keeps the search index when only the importance changes", async () => {
        const { store, json } = await setup();
        const original = draft();
        const id = store.addMemory(original);
        await json(`/api/memories/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ gist: original.gist, detail: original.detail, importance: 0.2 }),
        });
        expect(store.get(id)?.importance).toBe(0.2);
        expect(store.get(id)?.embedding).toBeDefined();
    });

    it("rejects an edit that would blank a memory or set extra fields", async () => {
        const { store, call } = await setup();
        const id = store.addMemory(draft());
        const patch = (body: unknown) => call(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        expect((await patch({ gist: "   ", detail: "", importance: 0.5 })).status).toBe(400);
        expect((await patch({ gist: "x", detail: "", importance: 2 })).status).toBe(400);
        expect((await patch({ gist: "x", detail: "", importance: 0.5, confidence: 1 })).status).toBe(400);
        expect(store.get(id)?.gist).toBe("alice likes noodles");
    });

    it("archives, restores and deletes", async () => {
        const { store, json, post, call } = await setup();
        const id = store.addMemory(draft());
        const newer = store.addMemory(draft({ gist: "newer" }));
        await post(`/api/memories/${id}/archive`);
        expect(store.get(id)?.status).toBe("archived");
        store.supersede(id, newer);
        expect((await json("/api/memories?state=replaced")).total).toBe(1);
        await post(`/api/memories/${id}/restore`);
        expect(store.get(id)).toMatchObject({ status: "active", supersededBy: null });
        await json(`/api/memories/${id}`, { method: "DELETE" });
        expect(store.get(id)).toBeUndefined();
        expect((await call(`/api/memories/${id}`)).status).toBe(404);
    });

    it("leaves an audit record of changes, without the memory's text", async () => {
        const { store, json, post, trace } = await setup();
        const id = store.addMemory(draft());
        await post(`/api/memories/${id}/archive`);
        await json(`/api/memories/${id}`, { method: "DELETE" });
        const actions = trace.ofKind("control.web").map((event) => event.detail);
        expect(actions).toEqual([
            { action: "archive_memory", memory: id },
            { action: "delete_memory", memory: id },
        ]);
        expect(JSON.stringify(actions)).not.toContain("noodles");
    });

    it("forgets a person from memory and from the live window", async () => {
        const { adapter, store, runtime, json } = await setup();
        adapter.say("alice", "secret");
        adapter.say("bob", "hi");
        store.addMemory(draft());
        const key = encodeURIComponent("cli:alice");
        expect(await json(`/api/people/${key}`)).toMatchObject({ displayName: "alice", memories: 1, messages: 1 });
        expect(await json(`/api/people/${key}`, { method: "DELETE" })).toEqual({ forgotten: 1 });
        expect(store.all()).toEqual([]);
        expect(runtime.conversation(CHANNEL)?.messages.map((message) => message.senderName)).toEqual(["bob"]);
    });

    it("refuses to forget the persona herself", async () => {
        const { call } = await setup();
        expect((await call(`/api/people/${encodeURIComponent("cli:self")}`, { method: "DELETE" })).status).toBe(400);
    });
});

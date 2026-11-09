import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CliAdapter } from "../src/adapters/cli.ts";
import { currentRelationship } from "../src/body/relationships.ts";
import { loadConfig } from "../src/config.ts";
import { People } from "../src/control/people.ts";
import { MemoryControlStore } from "../src/control/state.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { CostMeter } from "../src/lib/cost.ts";
import { Rng } from "../src/lib/rng.ts";
import { DecisionTrace } from "../src/lib/trace.ts";
import { NullEmbedder } from "../src/llm/embedder.ts";
import { FakeBackend } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";
import { type MemoryDraft, MemoryStore, type RelationshipRow } from "../src/memory/store.ts";
import { Runtime } from "../src/runtime.ts";
import { createConfigView } from "../src/web/config-view.ts";
import { isLoopback, resolveWebToken, WebServer } from "../src/web/server.ts";
import { PERSONA } from "./fixtures.ts";

const TOKEN = "correct-horse-battery-staple";
const CHANNEL = "cli:group";
const CHANNEL_PATH = encodeURIComponent(CHANNEL);
const ROLES = ["gate", "reply", "technical", "vision", "extract", "consolidate"];
const EXTRACTION = JSON.stringify({ summary: "they talked about noodles", importance: 0.8, emotion: 0.2, memories: [] });

const PUBLIC_DIRECTORY = new URL("../src/web/public/", import.meta.url);
const PAGE_SCRIPTS = readdirSync(PUBLIC_DIRECTORY).filter((file) => file.endsWith(".js"));

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

async function setup(options: { people?: People; configView?: () => unknown } = {}) {
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
        ...(options.people ? { people: options.people } : {}),
    });
    await runtime.start();
    const errors: string[] = [];
    const server = new WebServer({
        runtime,
        token: TOKEN,
        host: "127.0.0.1",
        port: 0,
        onError: (message) => errors.push(message),
        configView: options.configView,
    });
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
    return { adapter, store, runtime, base, call, json, post, errors, trace, clock };
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

    it("serves every script the page is made of", async () => {
        const { base } = await setup();
        for (const script of PAGE_SCRIPTS) expect((await fetch(`${base}/${script}`)).status, script).toBe(200);
    });

    it("serves only the known files", async () => {
        const { base } = await setup();
        expect((await fetch(`${base}/server.ts`)).status).toBe(404);
        expect((await fetch(`${base}/..%2fserver.ts`)).status).toBe(404);
        expect((await fetch(`${base}/public/app.js`)).status).toBe(404);
    });

    it("never builds markup from strings in the browser", () => {
        expect(PAGE_SCRIPTS).toContain("app.js");
        for (const script of PAGE_SCRIPTS) {
            expect(readFileSync(new URL(script, PUBLIC_DIRECTORY), "utf8"), script).not.toMatch(
                /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
            );
        }
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

    it("shows what a message is replying to", async () => {
        const { adapter, json } = await setup();
        adapter.say("bob", "hi");
        adapter.say("alice", "没", "group", { messageId: "old", by: "bob", byUser: "cli:bob", text: "吃了吗", isSelf: false });
        const { messages } = await json(`/api/conversations/${CHANNEL_PATH}`);
        expect(messages[0].isReply).toBe(false);
        expect(messages[1]).toMatchObject({ isReply: true, quoted: { senderName: "bob", text: "吃了吗" } });
    });

    it("drops a forgotten person's words from replies quoting them, in the window and after a restart", async () => {
        const { adapter, store, runtime, json } = await setup();
        const quote = { messageId: "old", by: "bob", byUser: "cli:bob", text: "my secret", isSelf: false };
        const id = adapter.say("alice", "没", "group", quote);
        store.markAttended(CHANNEL, [id]);
        await json(`/api/people/${encodeURIComponent("cli:bob")}`, { method: "DELETE" });
        expect(runtime.conversation(CHANNEL)?.messages[0]).toMatchObject({ isReply: true, quoted: undefined, text: "没" });
        const restored = store.recentAttended(CHANNEL, 10);
        expect(restored.map((message) => message.text)).toEqual(["没"]);
        expect(JSON.stringify(restored)).not.toContain("my secret");
    });

    it("never shows the words of someone who has opted out, even quoted", async () => {
        const { adapter, runtime } = await setup();
        adapter.say("bob", "/akanebot opt-out");
        adapter.say("alice", "没", "group", { messageId: "old", by: "bob", byUser: "cli:bob", text: "my secret", isSelf: false });
        const last = runtime.conversation(CHANNEL)?.messages.at(-1);
        expect(last).toMatchObject({ text: "没", isReply: true, quoted: undefined });
    });

    it("stores a quote so it can be restored after a restart", async () => {
        const { adapter, store } = await setup();
        const quote = { messageId: "old", by: "bob", byUser: "cli:bob", text: "吃了吗", isSelf: false };
        const id = adapter.say("alice", "没", "group", quote);
        store.markAttended(CHANNEL, [id]);
        expect(store.recentAttended(CHANNEL, 10)[0]).toMatchObject({ replyTo: quote, replyToMessageId: "old" });
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

    it("changes a memory's reach, but can't release one that must stay in its group", async () => {
        const { store, post, call, json } = await setup();
        const fact = store.addMemory(draft());
        const episode = store.addMemory(draft({ kind: "episode", subject: null }));
        await post(`/api/memories/${fact}/reach`, { reach: "shared" });
        expect(store.get(fact)?.reach).toBe("shared");
        expect((await json("/api/memories?reach=shared")).total).toBe(1);
        const refused = await call(`/api/memories/${episode}/reach`, { method: "POST", body: JSON.stringify({ reach: "shared" }) });
        expect(refused.status).toBe(400);
        expect(store.get(episode)?.reach).toBe("group");
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

const ALICE_KEY = encodeURIComponent("cli:alice");
const ALICE_ACCOUNTS = new People([
    { name: "Alice", ids: ["cli:alice", "discord:42"], note: "from the old server", aliases: ["Ally"], timezone: "Asia/Tokyo" },
]);

function relationshipRow(overrides: Partial<RelationshipRow> = {}): RelationshipRow {
    return {
        channel: CHANNEL,
        userKey: "cli:alice",
        familiarity: 0.5,
        affinity: 0.4,
        updatedAt: 1_000_000,
        gainDay: 11,
        dayGain: 0.02,
        ...overrides,
    };
}

describe("web console people", () => {
    it("lists a person once across linked accounts, with their standing", async () => {
        const { adapter, store, json } = await setup({ people: ALICE_ACCOUNTS });
        adapter.say("alice", "hi");
        adapter.say("bob", "hello");
        store.saveRelationship(relationshipRow({ channel: "discord:9", userKey: "discord:42", familiarity: 0.7 }));
        const { people } = await json("/api/people");
        expect(people.map((person: { name: string }) => person.name).sort()).toEqual(["Alice", "bob"]);
        const alice = people.find((person: { name: string }) => person.name === "Alice");
        expect(alice).toMatchObject({
            key: "cli:alice",
            accounts: ["cli:alice", "discord:42"],
            note: "from the old server",
            aliases: ["Ally"],
            timezone: "Asia/Tokyo",
            messages: 1,
            optedOut: false,
            standing: { familiarity: 0.7, affinity: 0.4 },
        });
        expect(alice.groups).toHaveLength(1);
        expect(people.find((person: { name: string }) => person.name === "bob").aliases).toEqual([]);
    });

    it("includes someone the config declares before they have said anything", async () => {
        const { json } = await setup({ people: ALICE_ACCOUNTS });
        const { people } = await json("/api/people");
        expect(people).toHaveLength(1);
        expect(people[0]).toMatchObject({ name: "Alice", messages: 0 });
        expect(people[0]).not.toHaveProperty("standing");
        expect(people[0]).not.toHaveProperty("lastSeen");
    });

    it("makes a correction stick across all of someone's rows, even lowering familiarity", async () => {
        const { store, json, clock, trace } = await setup({ people: ALICE_ACCOUNTS });
        store.saveRelationship(relationshipRow({ familiarity: 0.3 }));
        store.saveRelationship(relationshipRow({ channel: "discord:9", userKey: "discord:42", familiarity: 0.8 }));
        await json(`/api/people/${ALICE_KEY}/relationship`, { method: "PATCH", body: JSON.stringify({ familiarity: 0.1, affinity: -0.5 }) });
        expect(currentRelationship(store, "discord:42", clock.now(), ALICE_ACCOUNTS)).toEqual({ familiarity: 0.1, affinity: -0.5 });
        expect(trace.ofKind("control.web").at(-1)?.detail).toEqual({
            action: "correct_relationship",
            user: "cli:alice",
            familiarity: 0.1,
            affinity: -0.5,
        });
    });

    it("keeps the faded affinity when only familiarity is corrected, and the newest day's gain", async () => {
        const { store, json, clock } = await setup({ people: ALICE_ACCOUNTS });
        await clock.advance(30 * 86_400_000);
        store.saveRelationship(relationshipRow({ updatedAt: 1_000_000, gainDay: 3, dayGain: 0.09 }));
        store.saveRelationship(relationshipRow({ channel: "discord:9", userKey: "discord:42", updatedAt: 500_000, gainDay: 1, dayGain: 0.01 }));
        const faded = currentRelationship(store, "cli:alice", clock.now(), ALICE_ACCOUNTS).affinity;
        await json(`/api/people/${ALICE_KEY}/relationship`, { method: "PATCH", body: JSON.stringify({ familiarity: 0.2 }) });
        expect(currentRelationship(store, "cli:alice", clock.now(), ALICE_ACCOUNTS).affinity).toBeCloseTo(faded);
        expect(store.relationshipsOf(["cli:alice", "discord:42"]).map((row) => [row.gainDay, row.dayGain])).toEqual([
            [3, 0.09],
            [3, 0.09],
        ]);
    });

    it("won't invent feelings for someone she has none about", async () => {
        const { call } = await setup({ people: ALICE_ACCOUNTS });
        const response = await call(`/api/people/${ALICE_KEY}/relationship`, { method: "PATCH", body: JSON.stringify({ affinity: 0.5 }) });
        expect(response.status).toBe(404);
    });

    it("rejects out-of-range and empty corrections", async () => {
        const { store, call, errors } = await setup();
        store.saveRelationship(relationshipRow());
        for (const body of [{ affinity: 2 }, { familiarity: -0.1 }, {}, { familiarity: 0.5, extra: 1 }]) {
            expect((await call(`/api/people/${ALICE_KEY}/relationship`, { method: "PATCH", body: JSON.stringify(body) })).status).toBe(400);
        }
        expect(errors).toEqual([]);
    });

    it("resets a relationship on every account but keeps memories", async () => {
        const { store, json, trace } = await setup({ people: ALICE_ACCOUNTS });
        store.saveRelationship(relationshipRow());
        store.saveRelationship(relationshipRow({ channel: "discord:9", userKey: "discord:42" }));
        store.addMemory(draft());
        await json(`/api/people/${ALICE_KEY}/relationship`, { method: "DELETE" });
        expect(store.relationshipsOf(["cli:alice", "discord:42"])).toEqual([]);
        expect(store.all()).toHaveLength(1);
        expect(trace.ofKind("control.web").at(-1)?.detail).toEqual({ action: "reset_relationship", user: "cli:alice" });
    });

    it("opts someone out: their data and window go, and later messages aren't read", async () => {
        const { adapter, store, runtime, json, post, trace } = await setup({ people: ALICE_ACCOUNTS });
        adapter.say("alice", "secret");
        adapter.say("bob", "hi");
        store.addMemory(draft());
        expect(await post(`/api/people/${ALICE_KEY}/opt-out`)).toEqual({ forgotten: 1 });
        expect(store.all()).toEqual([]);
        adapter.say("alice", "still talking");
        expect(runtime.conversation(CHANNEL)?.messages.map((message) => message.senderName)).toEqual(["bob"]);
        const { people } = await json("/api/people");
        expect(people.find((person: { key: string }) => person.key === "cli:alice")).toMatchObject({ optedOut: true, messages: 0 });
        expect(trace.ofKind("control.web").at(-1)?.detail).toEqual({ action: "opt_out", user: "cli:alice" });
    });

    it("opts someone back in, on all their accounts, restoring reading only", async () => {
        const { adapter, store, runtime, post, trace } = await setup({ people: ALICE_ACCOUNTS });
        adapter.say("alice", "before");
        store.addMemory(draft());
        await post(`/api/people/${encodeURIComponent("discord:42")}/opt-out`);
        await post(`/api/people/${ALICE_KEY}/opt-in`);
        expect(store.all()).toEqual([]);
        adapter.say("alice", "after");
        expect(runtime.conversation(CHANNEL)?.messages.map((message) => message.text)).toEqual(["after"]);
        expect(trace.ofKind("control.web").at(-1)?.detail).toEqual({ action: "opt_in", user: "cli:alice" });
    });

    it("refuses to opt out the persona herself", async () => {
        const { call } = await setup();
        expect((await call(`/api/people/${encodeURIComponent("cli:self")}/opt-out`, { method: "POST" })).status).toBe(400);
    });

    it("doesn't list her own lines or group events as people", async () => {
        const { store, json } = await setup();
        const base = {
            platform: "cli",
            channelId: "group",
            text: "x",
            sentAt: 1,
            mentionsSelf: false,
            repliesToSelf: false,
            isBacklog: false,
        } as const;
        store.logMessage({ ...base, messageId: "a", sender: { id: "self", displayName: "Akane", isBot: true }, isSelf: true }, "cli:self", true);
        store.logMessage(
            { ...base, messageId: "b", sender: { id: "event", displayName: "(group event)", isBot: false }, isSelf: false },
            "cli:event",
            false,
        );
        expect((await json("/api/people")).people).toEqual([]);
    });
});

describe("web console status", () => {
    it("reports her body, day, limits and memory", async () => {
        const { adapter, store, json } = await setup();
        adapter.say("alice", "hi");
        store.addMemory(draft());
        store.addMemory(draft({ embedding: undefined, embeddingModel: null }));
        const body = await json("/api/body");
        expect(body).toMatchObject({
            state: "idle",
            battery: 1,
            searchesToday: 0,
            guard: { tokens: 10, capacity: 10, maxShare: 0.4 },
            memory: { active: 2, archived: 0, replaced: 0, unindexed: 1, messages: 1 },
            lastNight: {},
        });
        expect(body.activity).toMatch(/^(asleep|busy|free)$/);
        expect(body.day.mood).toBeGreaterThanOrEqual(-1);
        expect(body).not.toHaveProperty("present");
    });

    it("sets the battery without touching today's searches, and audits it", async () => {
        const { runtime, json, trace } = await setup();
        runtime.vitals.noteSearch();
        await json("/api/body/battery", { method: "PUT", body: JSON.stringify({ level: 0.25 }) });
        expect(runtime.vitals.battery()).toBeCloseTo(0.25);
        expect(runtime.vitals.searchesToday()).toBe(1);
        expect(trace.ofKind("control.web").at(-1)?.detail).toEqual({ action: "set_battery", level: 0.25 });
    });

    it("rejects a battery level out of range", async () => {
        const { call, errors } = await setup();
        for (const body of [{ level: 1.5 }, { level: -1 }, {}, { level: "full" }]) {
            expect((await call("/api/body/battery", { method: "PUT", body: JSON.stringify(body) })).status).toBe(400);
        }
        expect(errors).toEqual([]);
    });

    it("doesn't use up anything by being looked at", async () => {
        const { json, clock } = await setup();
        await clock.advance(1000);
        const first = await json("/api/body");
        const second = await json("/api/body");
        expect(second.guard).toEqual(first.guard);
    });
});

describe("web console history", () => {
    it("pages through the raw log newest first, including unread messages", async () => {
        const { adapter, json } = await setup();
        adapter.say("alice", "one");
        adapter.say("bob", "two");
        adapter.say("alice", "three");
        const page = await json("/api/history?limit=2");
        expect(page.total).toBe(3);
        expect(page.messages.map((message: { text: string }) => message.text)).toEqual(["three", "two"]);
        expect(page.messages[0]).toMatchObject({ senderKey: "cli:alice", attended: false, digested: false, channel: CHANNEL });
        expect(page.channels).toEqual([{ key: CHANNEL, name: expect.any(String) }]);
        expect((await json("/api/history?limit=2&offset=2")).messages.map((message: { text: string }) => message.text)).toEqual(["one"]);
    });

    it("filters by text, treating wildcards literally, and by every account of a person", async () => {
        const { adapter, store, json } = await setup({ people: ALICE_ACCOUNTS });
        adapter.say("alice", "100% sure");
        adapter.say("bob", "100 percent");
        store.logMessage(
            {
                platform: "discord",
                channelId: "9",
                messageId: "d1",
                sender: { id: "42", displayName: "Al", isBot: false },
                text: "from discord",
                sentAt: 5,
                mentionsSelf: false,
                repliesToSelf: false,
                isBacklog: false,
                isSelf: false,
            },
            "discord:42",
            false,
        );
        const search = (query: string) =>
            json(`/api/history?${query}`).then((page) => page.messages.map((message: { text: string }) => message.text));
        expect(await search(`q=${encodeURIComponent("100%")}`)).toEqual(["100% sure"]);
        expect((await search(`user=${ALICE_KEY}`)).sort()).toEqual(["100% sure", "from discord"]);
        expect(await search("channel=discord%3A9")).toEqual(["from discord"]);
    });

    it("deletes a message from the log, the window and any quote of it, keeping memory sources", async () => {
        const { adapter, store, runtime, json, trace } = await setup();
        const id = adapter.say("alice", "secret");
        adapter.say("bob", "replying", "group", { messageId: id, by: "alice", byUser: "cli:alice", text: "secret", isSelf: false });
        store.addMemory(draft({ sources: [{ messageId: id, speaker: "cli:alice" }] }));
        await json(`/api/history/${CHANNEL_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
        const page = await json("/api/history");
        expect(page.total).toBe(1);
        expect(JSON.stringify(page)).not.toContain("secret");
        expect(JSON.stringify(runtime.conversation(CHANNEL))).not.toContain("secret");
        const [memory] = store.all();
        expect(memory && store.sourcesOf(memory.id)).toHaveLength(1);
        expect(trace.ofKind("control.web").at(-1)).toMatchObject({ channel: CHANNEL, messageId: id, detail: { action: "delete_message" } });
    });

    it("says so when the message doesn't exist", async () => {
        const { call } = await setup();
        expect((await call(`/api/history/${CHANNEL_PATH}/nope`, { method: "DELETE" })).status).toBe(404);
    });

    it("rejects a bad page", async () => {
        const { call, errors } = await setup();
        expect((await call("/api/history?limit=0")).status).toBe(400);
        expect((await call("/api/history?offset=-1")).status).toBe(400);
        expect(errors).toEqual([]);
    });
});

describe("web console activity", () => {
    const Secret = "the-secret-words";

    it("keeps free text out of the bulk list", async () => {
        const { json, trace } = await setup();
        trace.record("gate.decision", {
            channel: CHANNEL,
            messageId: "m1",
            detail: {
                speak: true,
                probability: 0.5,
                mode: "casual",
                features: {
                    interest: 0.7,
                    towardMe: "friendly",
                    topic: Secret,
                    lookUp: Secret,
                    privateThought: Secret,
                    domain: Secret,
                    quickReaction: Secret,
                },
            },
        });
        trace.record("memory.recall", { channel: CHANNEL, detail: { recalled: [{ id: 3, gist: Secret, score: 0.9, detailed: false }] } });
        trace.record("send.sent", { channel: CHANNEL, messageId: "m2", detail: { text: Secret, mention: Secret } });
        trace.record("search.done", { channel: CHANNEL, detail: { query: Secret, note: Secret } });
        trace.record("alert", { detail: { reason: "memory_failed", error: Secret, message: Secret, detail: Secret } });
        const page = await json("/api/trace");
        expect(JSON.stringify(page)).not.toContain(Secret);
        const byKind = Object.fromEntries(page.events.map((event: { kind: string; detail: unknown }) => [event.kind, event.detail]));
        expect(byKind["gate.decision"]).toEqual({ speak: true, probability: 0.5, mode: "casual", interest: 0.7, towardMe: "friendly" });
        expect(byKind["memory.recall"]).toEqual({ recalled: [{ id: 3, score: 0.9, detailed: false }] });
        expect(byKind.alert).toEqual({ reason: "memory_failed" });
        expect(byKind["send.sent"]).toEqual({});
    });

    it("shows nothing of a kind nobody has listed", async () => {
        const { json, trace } = await setup();
        trace.record("brand.new", { detail: { count: 3, text: Secret } });
        expect((await json("/api/trace")).events[0].detail).toEqual({});
    });

    it("lists newest first, with filters and a limit", async () => {
        const { json, trace } = await setup();
        trace.record("body.away");
        trace.record("body.back");
        trace.record("body.expired", { channel: CHANNEL });
        const kinds = (query: string) => json(`/api/trace?${query}`).then((page) => page.events.map((event: { kind: string }) => event.kind));
        expect(await kinds("limit=2")).toEqual(["body.expired", "body.back"]);
        expect(await kinds("kind=body.away")).toEqual(["body.away"]);
        expect(await kinds(`channel=${CHANNEL_PATH}`)).toEqual(["body.expired"]);
        expect((await json("/api/trace")).kinds).toEqual(expect.arrayContaining(["body.away", "body.back", "body.expired"]));
    });

    it("rejects a bad limit", async () => {
        const { call, errors } = await setup();
        expect((await call("/api/trace?limit=0")).status).toBe(400);
        expect((await call("/api/trace?limit=100000")).status).toBe(400);
        expect(errors).toEqual([]);
    });
});

describe("web console settings", () => {
    const Credential = "planted-credential-value";

    function plantedConfig() {
        const raw = parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8"));
        const backend = Object.keys(raw.backends)[0] as string;
        const role = Object.keys(raw.roles)[0] as string;
        raw.backends[backend] = { ...raw.backends[backend], apiKey: Credential, baseUrl: `https://user:${Credential}@example.com` };
        raw.roles[role].options = { effort: "low", thinking: { type: "adaptive", token: Credential }, headers: { authorization: Credential } };
        raw.qq = { url: `wss://napcat.example:3001/ws?access_token=${Credential}` };
        const path = join(mkdtempSync(join(tmpdir(), "akanebot-config-")), "config.yaml");
        writeFileSync(path, stringify(raw));
        return { raw, path, role, config: loadConfig(path).config };
    }

    it("shows the live persona, read-only", async () => {
        const { json, call } = await setup();
        expect(await json("/api/persona")).toMatchObject({ name: PERSONA.name, timezone: PERSONA.timezone });
        expect((await call("/api/persona", { method: "PUT", body: "{}" })).status).toBe(405);
    });

    it("never shows a credential, wherever it was planted", async () => {
        const { path, config, role } = plantedConfig();
        const { json, call } = await setup({ configView: createConfigView(config, path) });
        const view = await json("/api/config");
        expect(JSON.stringify(view)).not.toContain(Credential);
        expect(view.config.qq.url).toBe("wss://napcat.example:3001");
        expect(view.config.llm.roles[role].options).toEqual({ effort: "low", thinking: "adaptive" });
        expect(view.disk).toEqual({ state: "matches" });
        expect((await call("/api/config", { method: "PATCH", body: "{}" })).status).toBe(405);
    });

    it("names the sections that changed on disk, and nothing else about them", async () => {
        const { raw, path, config } = plantedConfig();
        const view = createConfigView(config, path);
        writeFileSync(path, stringify({ ...raw, dailyBudgetUsd: 123.45 }));
        const disk = (view() as { disk: unknown }).disk;
        expect(disk).toEqual({ state: "differs", sections: ["dailyBudgetUsd"] });
        expect(JSON.stringify(disk)).not.toContain("123.45");
    });

    it("says only that the file can't be read when it's broken", () => {
        const { path, config } = plantedConfig();
        const view = createConfigView(config, path);
        writeFileSync(path, `dailyBudgetUsd: [${Credential}`);
        expect((view() as { disk: unknown }).disk).toEqual({ state: "unreadable" });
    });

    it("reports what a run replaces, and that some runs have no config", async () => {
        const { path, config } = plantedConfig();
        expect(createConfigView(config, path, ["timing"])()).toMatchObject({ overrides: ["timing"] });
        const { call } = await setup();
        expect((await call("/api/config")).status).toBe(404);
    });
});

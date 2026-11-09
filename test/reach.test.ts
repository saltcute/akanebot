import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.ts";
import { People } from "../src/control/people.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { Rng } from "../src/lib/rng.ts";
import { DecisionTrace } from "../src/lib/trace.ts";
import type { Embedder } from "../src/llm/embedder.ts";
import { FakeBackend, type FakeResponder } from "../src/llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../src/llm/registry.ts";
import { consolidate } from "../src/memory/consolidate.ts";
import { canCrossGroups, decideReach, isShareable } from "../src/memory/reach.ts";
import { type Memory, type MemoryDraft, MemoryStore } from "../src/memory/store.ts";
import { MemorySystem } from "../src/memory/system.ts";
import { renderReplyInstructions } from "../src/reply/prompt.ts";
import { PERSONA } from "./fixtures.ts";

const DAY = 86_400_000;
const HERE = "qq:a";
const THERE = "qq:b";
const WALLED = "qq:walled";
const GIST = "alice 最近在打 maimai 新版本";

class FakeEmbedder implements Embedder {
    readonly modelId = "fake";
    readonly cosineFloor = 0;
    readonly cosineCeiling = 1;

    async embed(text: string): Promise<Float32Array> {
        const vector = new Float32Array(64);
        for (let i = 0; i + 1 < text.length; i++) vector[(text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) % 64] = 1;
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
    }
}

function registry(extract: FakeResponder, resolve: FakeResponder = () => JSON.stringify({ replaced: [] })) {
    return new LlmRegistry(
        llmConfigSchema.parse({
            backends: { e: { type: "extract" }, k: { type: "consolidate" } },
            roles: { extract: { backend: "e", model: "m" }, consolidate: { backend: "k", model: "m" } },
        }),
        { extract: () => new FakeBackend(extract), consolidate: () => new FakeBackend(resolve) },
    );
}

function chat(id: string, speaker: string, text: string, channelId = "a", platform: ChatMessage["platform"] = "qq"): ChatMessage {
    return {
        platform,
        channelId,
        messageId: id,
        sender: { id: speaker, displayName: speaker, isBot: false },
        text,
        sentAt: 0,
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: false,
        isBacklog: false,
    };
}

function draft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
    return {
        scope: HERE,
        reach: "shared",
        kind: "fact",
        subject: "qq:alice",
        attributedTo: "qq:alice",
        gist: GIST,
        detail: "",
        importance: 0.8,
        salience: 0.5,
        confidence: 0.8,
        embedding: undefined,
        embeddingModel: null,
        sources: [{ messageId: "m1", speaker: "qq:alice" }],
        createdAt: 0,
        ...overrides,
    };
}

const candidate = (overrides = {}) => ({
    about: "alice",
    gist: GIST,
    detail: "",
    importance: 0.8,
    emotion: 0.1,
    lines: [1],
    isInstruction: false,
    reach: "general",
    ...overrides,
});
const output = (memories: unknown[], summary = "") => JSON.stringify({ summary, importance: 0.5, emotion: 0.1, memories });

function setup(extract: FakeResponder = () => output([]), people?: People) {
    const clock = new ManualClock();
    const trace = new DecisionTrace(clock);
    const store = new MemoryStore(":memory:");
    const open = new Set([HERE, THERE, "discord:c"]);
    const system = new MemorySystem({
        store,
        embedder: new FakeEmbedder(),
        llm: registry(extract),
        clock,
        rng: new Rng(1),
        trace,
        persona: () => PERSONA,
        settings: { segmentGapMs: 1000, maxSegmentMessages: 30, rawRetentionMs: 30 * DAY, dailyWritesPerUser: 30 },
        alert: () => {},
        sharesMemory: (channel) => open.has(channel),
        ...(people ? { people } : {}),
    });
    const digest = async (channel: string, ...messages: ChatMessage[]) => {
        for (const message of messages) system.recordIncoming(message);
        system.markAttended(channel, messages);
        await system.closeSegment(channel);
    };
    const recallFor = async (channel: string, speaker: string, platform: ChatMessage["platform"] = "qq") => {
        await indexAll(store);
        const separator = channel.indexOf(":");
        return system.recall(channel, [chat("q", speaker, GIST, channel.slice(separator + 1), platform)]);
    };
    return { store, system, trace, digest, recallFor, open };
}

/** Consolidation normally does this overnight. */
async function indexAll(store: MemoryStore) {
    const embedder = new FakeEmbedder();
    for (const memory of store.all()) {
        const vector = await embedder.embed(`${memory.gist} ${memory.detail}`);
        store.setEmbedding(memory.id, vector, embedder.modelId);
    }
}

describe("isShareable", () => {
    it.each([
        ["episode", null, false],
        ["event", null, false],
        ["claim", "name:bob", false],
        ["claim", "self", false],
        ["claim", "group", true],
        ["fact", "self", true],
        ["fact", "qq:alice", true],
        ["fact", "group", true],
    ] as const)("%s about %s: %s", (kind, subject, expected) => {
        expect(isShareable({ kind, subject })).toBe(expected);
    });
});

describe("decideReach", () => {
    const fact = { kind: "fact", subject: "qq:alice" } as const;
    const decide = (suggested: "general" | "group", conversation = "", groupShares = true) =>
        decideReach(fact, suggested, { groupShares, conversation });

    it("shares only what the model called general", () => {
        expect(decide("general")).toBe("shared");
        expect(decide("group")).toBe("group");
    });

    it("can't be widened past what's shareable", () => {
        expect(decideReach({ kind: "claim", subject: "name:bob" }, "general", { groupShares: true, conversation: "" })).toBe("group");
    });

    it("keeps a walled group's memories at home", () => {
        expect(decide("general", "", false)).toBe("group");
    });

    it.each(["这事别说出去", "别告诉别人", "不要外传哦", "帮我保密", "我只跟你说", "don't tell anyone", "keep this a secret", "just between us"])(
        "stays in the group after: %s",
        (phrase) => {
            expect(decide("general", phrase)).toBe("group");
        },
    );

    it("isn't tripped by ordinary talk", () => {
        expect(decide("general", "别说了 笑死 不要这样")).toBe("shared");
    });
});

describe("canCrossGroups", () => {
    const memory = (overrides: Partial<Memory>): Memory => ({
        ...draft(),
        id: 1,
        reach: "shared",
        strength: 1,
        lastRecalledAt: null,
        recallCount: 0,
        status: "active",
        supersededBy: null,
        ...overrides,
    });

    it("needs the memory to be shared", () => {
        expect(canCrossGroups(memory({ reach: "group" }), ["qq:alice"])).toBe(false);
    });

    it("surfaces someone's own news only while they're talking", () => {
        expect(canCrossGroups(memory({}), ["qq:alice"])).toBe(true);
        expect(canCrossGroups(memory({}), ["qq:bob"])).toBe(false);
    });

    it("lets what she said about herself and world news travel freely", () => {
        expect(canCrossGroups(memory({ subject: "self" }), [])).toBe(true);
        expect(canCrossGroups(memory({ subject: "group", kind: "claim" }), [])).toBe(true);
    });

    it("holds the line even if a row was edited by hand", () => {
        expect(canCrossGroups(memory({ kind: "episode", subject: null }), ["qq:alice"])).toBe(false);
        expect(canCrossGroups(memory({ kind: "claim", subject: "name:alice" }), ["name:alice"])).toBe(false);
    });
});

describe("writing memories", () => {
    it("marks a general self-reported fact as shared, and its conversation summary as not", async () => {
        const { store, digest } = setup(() => output([candidate()], "聊了音游"));
        await digest(HERE, chat("m1", "alice", "我最近在打 maimai"));
        expect(store.all().map((memory) => [memory.kind, memory.reach])).toEqual([
            ["episode", "group"],
            ["fact", "shared"],
        ]);
    });

    it("keeps everything from a conversation where someone asked for discretion, even on another line", async () => {
        const { store, digest } = setup(() => output([candidate()]));
        await digest(HERE, chat("m1", "alice", "我最近在打 maimai"), chat("m2", "alice", "别告诉别人哈"));
        expect(store.all()[0]?.reach).toBe("group");
    });

    it("never shares what one person said about another", async () => {
        const { store, digest } = setup(() => output([candidate({ about: "carol" })]));
        await digest(HERE, chat("m1", "alice", "carol 在打 maimai"));
        expect(store.all()[0]).toMatchObject({ kind: "claim", reach: "group" });
    });

    it("keeps a walled group's memories in that group", async () => {
        const { store, digest } = setup(() => output([candidate()]));
        await digest(WALLED, chat("m1", "alice", "我最近在打 maimai", "walled"));
        expect(store.all()[0]?.reach).toBe("group");
    });
});

describe("recalling across groups", () => {
    it("brings someone's own news up in another group while they're talking", async () => {
        const { store, recallFor } = setup();
        store.addMemory(draft());
        const { block } = await recallFor(THERE, "alice");
        expect(block).toContain(GIST);
        expect(block).toContain("(from another group)");
    });

    it("doesn't give it up to someone asking about them", async () => {
        const { store, recallFor } = setup();
        store.addMemory(draft());
        expect((await recallFor(THERE, "bob")).recalled).toEqual([]);
    });

    it("keeps group-only memories in their group", async () => {
        const { store, recallFor } = setup();
        store.addMemory(draft({ reach: "group" }));
        expect((await recallFor(THERE, "alice")).recalled).toEqual([]);
        expect((await recallFor(HERE, "alice")).recalled).toHaveLength(1);
    });

    it("recognizes a person on their other platform", async () => {
        const people = new People([{ name: "alice", ids: ["qq:alice", "discord:a1"] }]);
        const { store, recallFor } = setup(undefined, people);
        store.addMemory(draft());
        expect((await recallFor("discord:c", "a1", "discord")).recalled).toHaveLength(1);
    });

    it("gives a walled group nothing from elsewhere", async () => {
        const { store, recallFor } = setup();
        store.addMemory(draft());
        expect((await recallFor(WALLED, "alice")).recalled).toEqual([]);
    });

    it("stops drawing on a group as soon as it's walled off", async () => {
        const { store, recallFor, open } = setup();
        store.addMemory(draft());
        open.delete(HERE);
        expect((await recallFor(THERE, "alice")).recalled).toEqual([]);
    });

    it("doesn't remember the same thing twice because two groups heard it", async () => {
        const { store, recallFor } = setup();
        store.addMemory(draft());
        store.addMemory(draft({ scope: "discord:c", sources: [{ messageId: "m2", speaker: "qq:alice" }] }));
        expect((await recallFor(THERE, "alice")).recalled).toHaveLength(1);
    });

    it("records the crossing against the message, for /why", async () => {
        const { store, recallFor, trace } = setup();
        store.addMemory(draft());
        await recallFor(THERE, "alice");
        const [event] = trace.forMessage("q").filter((entry) => entry.kind === "memory.recall");
        expect(event?.detail?.recalled).toMatchObject([{ fromGroup: HERE }]);
    });

    it("tells her not to say where she heard it", () => {
        expect(renderReplyInstructions(PERSONA)).toContain("never say where you heard it");
    });
});

describe("consolidating shared memories", () => {
    const shares = (scope: string) => scope !== WALLED;

    function run(store: MemoryStore, resolve?: FakeResponder, people?: People) {
        return consolidate({
            store,
            embedder: new FakeEmbedder(),
            llm: registry(() => "", resolve),
            now: DAY,
            rawRetentionMs: 30 * DAY,
            signal: new AbortController().signal,
            sharesMemory: shares,
            ...(people ? { people } : {}),
        });
    }

    it("narrows a merged memory if either copy had to stay in its group", async () => {
        const store = new MemoryStore(":memory:");
        const keeper = store.addMemory(draft({ importance: 0.9 }));
        store.addMemory(draft({ reach: "group", sources: [{ messageId: "m2", speaker: "qq:alice" }] }));
        await run(store);
        expect(store.get(keeper)?.reach).toBe("group");
    });

    it("lets a shared fact from one group update one from another, across linked accounts", async () => {
        const store = new MemoryStore(":memory:");
        const people = new People([{ name: "alice", ids: ["qq:alice", "discord:a1"] }]);
        const older = store.addMemory(draft({ gist: "alice 住在北京" }));
        const newer = store.addMemory(
            draft({ scope: "discord:c", subject: "discord:a1", attributedTo: "discord:a1", gist: "alice 搬去了上海", createdAt: 10 }),
        );
        await run(store, () => JSON.stringify({ replaced: [{ oldId: older, newId: newer }] }), people);
        expect(store.get(older)?.supersededBy).toBe(newer);
    });

    it("never shows the model a private fact while comparing across groups", async () => {
        const store = new MemoryStore(":memory:");
        store.addMemory(draft({ gist: "alice 喜欢音游" }));
        store.addMemory(draft({ scope: THERE, gist: "alice 喜欢百合" }));
        store.addMemory(draft({ scope: THERE, reach: "group", gist: "alice 生病了" }));
        const seen: string[] = [];
        await run(store, (request) => {
            seen.push(request.transcript);
            return JSON.stringify({ replaced: [] });
        });
        const crossGroup = seen.filter((text) => text.includes("音游"));
        expect(crossGroup).toHaveLength(1);
        expect(crossGroup[0]).not.toContain("生病");
    });
});

describe("an older database", () => {
    it("gains the column with every existing memory staying in its group", () => {
        const dir = mkdtempSync(join(tmpdir(), "akane-reach-"));
        const path = join(dir, "memory.db");
        const before = new MemoryStore(path);
        before.addMemory(draft({ reach: "group" }));
        before.close();
        const raw = new DatabaseSync(path);
        raw.exec("ALTER TABLE memories DROP COLUMN reach");
        raw.close();
        const after = new MemoryStore(path);
        expect(after.all()[0]?.reach).toBe("group");
        after.close();
        rmSync(dir, { recursive: true });
    });
});

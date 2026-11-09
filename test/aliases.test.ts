import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.ts";
import { People } from "../src/control/people.ts";
import type { Recalled } from "../src/memory/recall.ts";
import type { Memory } from "../src/memory/store.ts";
import { explainAliases } from "../src/reply/aliases.ts";

const said = (id: string, displayName: string, text: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    platform: "cli",
    channelId: "g",
    messageId: `m-${id}`,
    sender: { id, displayName, isBot: false },
    text,
    sentAt: 0,
    mentionsSelf: false,
    repliesToSelf: false,
    isSelf: false,
    isBacklog: false,
    ...overrides,
});

const remembered = (gist: string, detail: string, detailed: boolean): Recalled => ({ memory: { gist, detail } as Memory, score: 1, detailed });

const PEOPLE = new People([{ name: "土豆", ids: ["cli:potato", "qq:1"], note: "老朋友", aliases: ["薯仔", "spud"] }]);
const NICKNAME = { name: "薯仔", description: "a nickname for 土豆" };

describe("explainAliases", () => {
    it("explains an alias that comes up in the chat", () => {
        expect(explainAliases(PEOPLE, [said("alice", "alice", "薯仔昨天去哪了")], [])).toEqual([NICKNAME]);
    });

    it("stays quiet when no alias comes up", () => {
        expect(explainAliases(PEOPLE, [said("alice", "alice", "今天吃什么")], [])).toEqual([]);
    });

    it("explains an alias in a recalled memory, but not in detail it wasn't shown", () => {
        expect(explainAliases(PEOPLE, [], [remembered("薯仔喜欢音游", "", false)])).toEqual([NICKNAME]);
        expect(explainAliases(PEOPLE, [], [remembered("有人喜欢音游", "薯仔说的", true)])).toEqual([NICKNAME]);
        expect(explainAliases(PEOPLE, [], [remembered("有人喜欢音游", "薯仔说的", false)])).toEqual([]);
    });

    it("matches Latin aliases as whole words, in any case", () => {
        expect(explainAliases(PEOPLE, [said("alice", "alice", "where is SPUD?")], [])).toEqual([
            { name: "spud", description: "a nickname for 土豆" },
        ]);
        expect(explainAliases(PEOPLE, [said("alice", "alice", "spuds are great")], [])).toEqual([]);
    });

    it("doesn't count a display name", () => {
        expect(explainAliases(PEOPLE, [said("potato", "薯仔", "hi")], [])).toEqual([]);
    });

    it("leaves out an alias someone else is using as their name", () => {
        const window = [said("mallory", "薯仔", "我是薯仔"), said("alice", "alice", "薯仔你好")];
        expect(explainAliases(PEOPLE, window, [])).toEqual([]);
    });

    it("still explains it when the display name is the person's own", () => {
        expect(explainAliases(PEOPLE, [said("potato", "薯仔", "薯仔来了")], [])).toEqual([NICKNAME]);
    });

    it("ignores its own messages and group events", () => {
        const window = [said("self", "小茜", "薯仔", { isSelf: true }), said("x", "x", "薯仔 joined", { groupEvent: { involves: [] } })];
        expect(explainAliases(PEOPLE, window, [])).toEqual([]);
    });
});

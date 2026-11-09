import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.ts";
import { decideToRepeat, NEUTRAL_CONTEXT } from "../src/gate/policy.ts";
import { findRepeatChain } from "../src/gate/repeat.ts";
import { Rng } from "../src/lib/rng.ts";
import { features, PERSONA } from "./fixtures.ts";

let nextId = 0;

function said(speaker: string, text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        platform: "cli",
        channelId: "group",
        messageId: `m${nextId++}`,
        sender: { id: speaker, displayName: speaker, isBot: false },
        text,
        sentAt: 0,
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: false,
        isBacklog: false,
        ...overrides,
    };
}

describe("findRepeatChain", () => {
    it("finds a line two people have sent in a row", () => {
        expect(findRepeatChain([said("carol", "早"), said("alice", "草"), said("bob", "草")])).toBe("草");
    });

    it("ignores one person saying the same thing twice", () => {
        expect(findRepeatChain([said("alice", "草"), said("alice", "草")])).toBeUndefined();
    });

    it("needs the chain to reach the latest message", () => {
        expect(findRepeatChain([said("alice", "草"), said("bob", "草"), said("carol", "吃饭了吗")])).toBeUndefined();
    });

    it("isn't broken by something the platform showed", () => {
        expect(findRepeatChain([said("alice", "草"), said("system", "carol joined", { groupEvent: { involves: [] } }), said("bob", "草")])).toBe(
            "草",
        );
    });

    it("joins a chain only once", () => {
        const window = [said("alice", "草"), said("小茜", "草", { isSelf: true }), said("bob", "草"), said("carol", "草")];
        expect(findRepeatChain(window)).toBeUndefined();
    });

    it("doesn't count bots as people", () => {
        const bot = { sender: { id: "bot", displayName: "bot", isBot: true } };
        expect(findRepeatChain([said("bot", "草", bot), said("alice", "草")])).toBeUndefined();
    });

    it.each(["[image]", "[表情]", "@bob 草", "看 https://example.com", "/ban bob", "第一行\n第二行", "长".repeat(41)])("won't repeat %j", (text) => {
        expect(findRepeatChain([said("alice", text), said("bob", text)])).toBeUndefined();
    });

    it("won't treat two different pictures as the same message", () => {
        const image = { images: [{ url: "https://example.com/a.png" }] };
        expect(findRepeatChain([said("alice", "草", image), said("bob", "草", image)])).toBeUndefined();
    });

    it("leaves a line aimed at the agent to the normal path", () => {
        expect(findRepeatChain([said("alice", "草", { mentionsSelf: true }), said("bob", "草")])).toBeUndefined();
    });
});

describe("decideToRepeat", () => {
    const persona = { ...PERSONA, repeatRate: 0.5 };

    it("joins in only some of the time", () => {
        const rng = new Rng(7);
        const repeats = Array.from({ length: 200 }, () => decideToRepeat(features(), persona, rng).repeat).filter(Boolean).length;
        expect(repeats).toBeGreaterThan(60);
        expect(repeats).toBeLessThan(140);
    });

    it("never repeats what the gate flagged, however eager it is", () => {
        const eager = { ...PERSONA, repeatRate: 1 };
        expect(decideToRepeat(features({ safeToRepeat: false }), eager, new Rng(1)).probability).toBe(0);
        expect(decideToRepeat(features({ highStakes: true }), eager, new Rng(1)).probability).toBe(0);
    });

    it("doesn't pick up a chain that went cold", () => {
        expect(decideToRepeat(features(), persona, new Rng(1), { ...NEUTRAL_CONTEXT, staleMs: 3_600_000 }).probability).toBe(0);
    });

    it("stops once the battery is empty", () => {
        expect(decideToRepeat(features(), persona, new Rng(1), { ...NEUTRAL_CONTEXT, battery: 0 }).probability).toBe(0);
    });
});

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.ts";
import { type Mentionable, mentionablePeople, resolveMentions } from "../src/reply/mentions.ts";

const said = (id: string, displayName: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    platform: "cli",
    channelId: "g",
    messageId: `m-${id}`,
    sender: { id, displayName, isBot: false },
    text: "hi",
    sentAt: 0,
    mentionsSelf: false,
    repliesToSelf: false,
    isSelf: false,
    isBacklog: false,
    ...overrides,
});

const BOB: Mentionable = { name: "bob", userId: "1" };
const CAROL: Mentionable = { name: "carol", userId: "2" };

describe("mentionablePeople", () => {
    it("lists who has spoken, once each", () => {
        expect(mentionablePeople([said("1", "bob"), said("1", "bob")])).toEqual([BOB]);
    });

    it("leaves out itself, bots and platform events", () => {
        const window = [
            said("self", "小茜", { isSelf: true }),
            said("3", "helper", { sender: { id: "3", displayName: "helper", isBot: true } }),
            said("event", "group", { groupEvent: { involves: [] } }),
        ];
        expect(mentionablePeople(window)).toEqual([]);
    });

    it("leaves out a name two people share", () => {
        expect(mentionablePeople([said("1", "bob"), said("2", "bob"), said("3", "carol")])).toEqual([{ name: "carol", userId: "3" }]);
    });

    it("uses the name the model was shown", () => {
        expect(mentionablePeople([said("1", "b:ob")])[0]?.name).toBe("b ob");
    });

    it("puts longer names first, so one that contains another isn't cut short", () => {
        const people = mentionablePeople([said("1", "玖花"), said("2", "玖花花💤")]);
        expect(resolveMentions(["@玖花花💤 骂他"], people)[0]?.mention?.userId).toBe("2");
    });
});

describe("resolveMentions", () => {
    it("marks where the mention is", () => {
        expect(resolveMentions(["hi @bob ok"], [BOB])).toEqual([{ text: "hi @bob ok", mention: { userId: "1", start: 3, end: 7 } }]);
    });

    it("works with no space after a Chinese name", () => {
        const people = [{ name: "糯米", userId: "9" }];
        expect(resolveMentions(["@糯米广东冷吗"], people)[0]?.mention).toEqual({ userId: "9", start: 0, end: 3 });
    });

    it("notifies only the first person, and later ones become plain names", () => {
        expect(resolveMentions(["@bob @carol @bob 看"], [BOB, CAROL])).toEqual([
            { text: "@bob carol bob 看", mention: { userId: "1", start: 0, end: 4 } },
        ]);
    });

    it("notifies at most once across a whole reply", () => {
        expect(resolveMentions(["@bob 看", "@carol 也看"], [BOB, CAROL])).toEqual([
            { text: "@bob 看", mention: { userId: "1", start: 0, end: 4 } },
            { text: "carol 也看" },
        ]);
    });

    it.each(["@everyone 开饭", "@全体成员 开会", "@Override", "@dave 在吗"])("leaves %s as typed", (burst) => {
        expect(resolveMentions([burst], [BOB])).toEqual([{ text: burst }]);
    });

    it("doesn't match inside a longer word or an email address", () => {
        expect(resolveMentions(["@bobby 在吗"], [BOB])).toEqual([{ text: "@bobby 在吗" }]);
        expect(resolveMentions(["mail me@bob"], [BOB])).toEqual([{ text: "mail me@bob" }]);
    });

    it("leaves code alone", () => {
        const code = "```\n@bob\n```";
        expect(resolveMentions([code], [BOB])).toEqual([{ text: code }]);
    });
});

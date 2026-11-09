import { AuditLogEvent, type Client, GatewayIntentBits, type Message, type MessageReaction, MessageType, Partials, type User } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDiscordClient, DiscordAdapter, readAuditEntry, toChatMessage, toReactionEvent, toSystemGroupEvent } from "../src/adapters/discord.ts";

const SELF = "999";

function collection<T>(items: T[]) {
    return items;
}

function discordMessage(overrides: Record<string, unknown> = {}): Message {
    return {
        id: "m1",
        channelId: "c1",
        system: false,
        inGuild: () => true,
        cleanContent: "hello",
        attachments: collection([]),
        stickers: collection([]),
        createdTimestamp: 1234,
        author: { id: "u1", bot: false, displayName: "global name" },
        member: { displayName: "server nick" },
        mentions: { users: new Map(), repliedUser: null },
        reference: null,
        channel: { messages: { cache: new Map() } },
        ...overrides,
    } as unknown as Message;
}

describe("toChatMessage", () => {
    it("maps an ordinary message", () => {
        expect(toChatMessage(discordMessage(), SELF)).toEqual({
            platform: "discord",
            channelId: "c1",
            messageId: "m1",
            sender: { id: "u1", displayName: "server nick", isBot: false },
            text: "hello",
            sentAt: 1234,
            mentionsSelf: false,
            repliesToSelf: false,
            isSelf: false,
            isBacklog: false,
        });
    });

    it("ignores direct messages and system messages", () => {
        expect(toChatMessage(discordMessage({ inGuild: () => false }), SELF)).toBeUndefined();
        expect(toChatMessage(discordMessage({ system: true }), SELF)).toBeUndefined();
    });

    it("falls back to the global name outside a member cache", () => {
        expect(toChatMessage(discordMessage({ member: null }), SELF)?.sender.displayName).toBe("global name");
    });

    it("recognizes an @mention of itself by ID", () => {
        expect(toChatMessage(discordMessage({ mentions: { users: new Map([[SELF, {}]]), repliedUser: null } }), SELF)?.mentionsSelf).toBe(true);
    });

    it("lists other people it mentions by their server name, and leaves itself out", () => {
        const users = new Map([
            [SELF, { displayName: "me" }],
            ["a", { displayName: "global a" }],
            ["b", { displayName: "global b" }],
        ]);
        const members = new Map([["a", { displayName: "nick a" }]]);
        expect(toChatMessage(discordMessage({ mentions: { users, members, repliedUser: null } }), SELF)?.mentions).toEqual(["nick a", "global b"]);
    });

    it("doesn't count someone else's mention", () => {
        expect(toChatMessage(discordMessage({ mentions: { users: new Map([["other", {}]]), repliedUser: null } }), SELF)?.mentionsSelf).toBe(false);
    });

    it("recognizes a reply to itself even with the reply ping turned off", () => {
        const channel = { messages: { cache: new Map([["old", discordMessage({ id: "old", author: { id: SELF } })]]) } };
        const mapped = toChatMessage(discordMessage({ reference: { messageId: "old" }, channel }), SELF);
        expect(mapped).toMatchObject({ repliesToSelf: true, replyToMessageId: "old" });
    });

    it("quotes the message being replied to, the way the chat app previews it", () => {
        const original = discordMessage({ id: "old", cleanContent: "吃了吗", attachments: collection([{ contentType: "image/png" }]) });
        const channel = { messages: { cache: new Map([["old", original]]) } };
        const mapped = toChatMessage(discordMessage({ reference: { messageId: "old" }, channel }), SELF);
        expect(mapped?.replyTo).toEqual({ messageId: "old", by: "server nick", byUser: "discord:u1", text: "吃了吗 [image]", isSelf: false });
    });

    it("still reads a reply when the original isn't available", () => {
        const partial = { id: "old", partial: true, author: null };
        const channel = { messages: { cache: new Map([["old", partial]]) } };
        const mapped = toChatMessage(discordMessage({ reference: { messageId: "old" }, channel }), SELF);
        expect(mapped).toMatchObject({ text: "hello", replyToMessageId: "old" });
        expect(mapped?.replyTo).toBeUndefined();
    });

    it("flags its own messages", () => {
        expect(toChatMessage(discordMessage({ author: { id: SELF, bot: true, displayName: "me" } }), SELF)?.isSelf).toBe(true);
    });

    it("marks other bots", () => {
        expect(toChatMessage(discordMessage({ author: { id: "b", bot: true, displayName: "b" }, member: null }), SELF)?.sender.isBot).toBe(true);
    });

    it("describes attachments and stickers instead of dropping them", () => {
        const attachments = collection([{ contentType: "image/png" }, { contentType: "application/pdf" }, { contentType: null }]);
        const stickers = collection([{}]);
        expect(toChatMessage(discordMessage({ cleanContent: "看", attachments, stickers }), SELF)?.text).toBe("看 [image] [file] [file] [sticker]");
    });

    it("passes image URLs along, skipping non-images and huge files", () => {
        const items = [
            { contentType: "image/png", size: 100, url: "https://cdn/a.png" },
            { contentType: "application/pdf", size: 100, url: "https://cdn/b.pdf" },
            { contentType: "image/png", size: 9_000_000, url: "https://cdn/huge.png" },
        ];
        expect(toChatMessage(discordMessage({ attachments: items }), SELF)?.images).toEqual([{ url: "https://cdn/a.png" }]);
    });

    it("names stickers", () => {
        expect(toChatMessage(discordMessage({ cleanContent: "", stickers: collection([{ name: "hi" }]) }), SELF)?.text).toBe("[sticker: hi]");
    });

    it("skips messages with nothing to read", () => {
        expect(toChatMessage(discordMessage({ cleanContent: "" }), SELF)).toBeUndefined();
    });
});

describe("toReactionEvent", () => {
    const user = { id: "u1", bot: false, displayName: "global name" } as unknown as User;
    const reactionOn = (overrides: Record<string, unknown> = {}, emojiName: string | null = "👍") =>
        ({
            emoji: { name: emojiName },
            message: {
                id: "m1",
                channelId: "c1",
                guildId: "g1",
                guild: { members: { cache: new Map([["u1", { displayName: "server nick" }]]) } },
                ...overrides,
            },
        }) as unknown as MessageReaction;

    it("maps a reaction, preferring the server nickname", () => {
        expect(toReactionEvent(reactionOn(), user, SELF, false)).toEqual({
            platform: "discord",
            channelId: "c1",
            messageId: "m1",
            emoji: "👍",
            reactor: { id: "u1", displayName: "server nick", isBot: false },
            isSelf: false,
            removed: false,
        });
    });

    it("works when the message was never cached", () => {
        expect(toReactionEvent(reactionOn({ guild: null }), user, SELF, false)?.reactor.displayName).toBe("global name");
    });

    it("flags its own reactions and removals", () => {
        const self = { id: SELF, bot: true, displayName: "me" } as unknown as User;
        expect(toReactionEvent(reactionOn(), self, SELF, true)).toMatchObject({ isSelf: true, removed: true });
    });

    it("ignores direct messages and reactions it can't name", () => {
        expect(toReactionEvent(reactionOn({ guildId: null }), user, SELF, false)).toBeUndefined();
        expect(toReactionEvent(reactionOn({}, null), user, SELF, false)).toBeUndefined();
    });
});

describe("createDiscordClient", () => {
    it("asks for reaction events and tolerates uncached messages", () => {
        const client = createDiscordClient();
        expect(client.options.intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
        expect(client.options.partials).toEqual(expect.arrayContaining([Partials.Message, Partials.Reaction, Partials.User]));
    });
});

describe("DiscordAdapter.send", () => {
    function setup(sendable = true) {
        const sent: Record<string, unknown>[] = [];
        const target = {
            isSendable: () => sendable,
            send: async (payload: Record<string, unknown>) => {
                sent.push(payload);
                return { id: "new1" };
            },
        };
        const client = { channels: { fetch: async () => target } } as unknown as Client;
        return { sent, adapter: new DiscordAdapter({ token: "t", client }) };
    }
    const channel = { platform: "discord", channelId: "c1" } as const;

    it("notifies only the person code resolved", async () => {
        const { sent, adapter } = setup();
        await adapter.send(channel, "hi @bob @everyone", { mention: { userId: "42", start: 3, end: 7 } });
        expect(sent[0]).toMatchObject({ content: "hi <@42> @everyone", allowedMentions: { parse: [], users: ["42"] } });
    });

    it("never lets model output ping anyone", async () => {
        const { sent, adapter } = setup();
        await expect(adapter.send(channel, "@everyone 开饭了")).resolves.toEqual({ messageId: "new1" });
        expect(sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    });

    it("stays within Discord's length limit", async () => {
        const { sent, adapter } = setup();
        await adapter.send(channel, "x".repeat(5000));
        expect(sent[0]?.content).toHaveLength(2000);
    });

    it("can reply to a message without failing if it was deleted", async () => {
        const { sent, adapter } = setup();
        await adapter.send(channel, "hi", { replyToMessageId: "m9" });
        expect(sent[0]).toMatchObject({ reply: { messageReference: "m9", failIfNotExists: false } });
    });

    it("reports a channel it can't post in", async () => {
        const { adapter } = setup(false);
        await expect(adapter.send(channel, "hi")).rejects.toThrow(/can't be sent to/);
    });
});

describe("toSystemGroupEvent", () => {
    it("maps a pin notice to the message it pinned", () => {
        const message = discordMessage({ system: true, type: MessageType.ChannelPinnedMessage, reference: { messageId: "old" } });
        expect(toSystemGroupEvent(message, SELF)).toMatchObject({
            platform: "discord",
            channelId: "c1",
            kind: "pinned",
            actor: { id: "u1", displayName: "server nick" },
            messageId: "old",
            at: 1234,
        });
    });

    it("maps someone joining", () => {
        expect(toSystemGroupEvent(discordMessage({ system: true, type: MessageType.UserJoin }), SELF)).toMatchObject({
            kind: "joined",
            target: { id: "u1" },
            targetIsSelf: false,
        });
    });

    it("ignores ordinary messages and other system messages", () => {
        expect(toSystemGroupEvent(discordMessage(), SELF)).toBeUndefined();
        expect(toSystemGroupEvent(discordMessage({ system: true, type: MessageType.GuildBoost }), SELF)).toBeUndefined();
    });
});

describe("readAuditEntry", () => {
    const entry = (action: AuditLogEvent, overrides: Record<string, unknown> = {}) =>
        ({ action, changes: [], extra: null, createdTimestamp: Date.parse("2026-01-01T00:00:00Z"), ...overrides }) as never;

    it("reads a timeout and how long it lasts", () => {
        const changes = [{ key: "communication_disabled_until", new: "2026-01-01T00:10:00Z" }];
        expect(readAuditEntry(entry(AuditLogEvent.MemberUpdate, { changes }))).toEqual({ kind: "muted", durationMs: 600_000 });
    });

    it("reads a timeout being lifted", () => {
        const changes = [{ key: "communication_disabled_until", old: "2026-01-01T00:10:00Z" }];
        expect(readAuditEntry(entry(AuditLogEvent.MemberUpdate, { changes }))).toEqual({ kind: "unmuted" });
    });

    it("ignores other member updates, such as a nickname change", () => {
        expect(readAuditEntry(entry(AuditLogEvent.MemberUpdate, { changes: [{ key: "nick", new: "x" }] }))).toBeUndefined();
    });

    it("reads kicks, bans and unpins", () => {
        expect(readAuditEntry(entry(AuditLogEvent.MemberKick))).toEqual({ kind: "kicked" });
        expect(readAuditEntry(entry(AuditLogEvent.MemberBanAdd))).toEqual({ kind: "banned" });
        expect(readAuditEntry(entry(AuditLogEvent.MemberBanRemove))).toEqual({ kind: "unbanned" });
        const extra = { channel: { id: "c1" }, messageId: "m1" };
        expect(readAuditEntry(entry(AuditLogEvent.MessageUnpin, { extra }))).toEqual({ kind: "unpinned", channelId: "c1", messageId: "m1" });
    });

    it("ignores the rest of the audit log", () => {
        expect(readAuditEntry(entry(AuditLogEvent.ChannelCreate))).toBeUndefined();
    });

    it("subscribes to audit log entries", () => {
        expect(createDiscordClient().options.intents.has(GatewayIntentBits.GuildModeration)).toBe(true);
    });
});

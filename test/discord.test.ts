import { EventEmitter } from "node:events";
import {
    type Client,
    Collection,
    Events,
    GatewayIntentBits,
    InteractionType,
    type Message,
    type MessageReaction,
    MessageReferenceType,
    MessageType,
    Partials,
    type User,
} from "discord.js";
import { describe, expect, it } from "vitest";
import {
    createDiscordClient,
    DiscordAdapter,
    toChatMessage,
    toCommandEvent,
    toLateImages,
    toReactionEvent,
    toRevision,
    toSystemGroupEvent,
} from "../src/adapters/discord.ts";

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
        embeds: [],
        createdTimestamp: 1234,
        author: { id: "u1", bot: false, displayName: "global name" },
        member: { displayName: "server nick" },
        mentions: { users: new Map(), repliedUser: null },
        reference: null,
        channel: { messages: { cache: new Map() } },
        ...overrides,
    } as unknown as Message;
}

function forwardOf(snapshot: Record<string, unknown>, overrides: Record<string, unknown> = {}): Message {
    return discordMessage({
        cleanContent: "",
        reference: { messageId: "original", channelId: "elsewhere", type: MessageReferenceType.Forward },
        messageSnapshots: new Collection([["original", { content: "", attachments: new Collection(), stickers: new Collection(), ...snapshot }]]),
        ...overrides,
    });
}

describe("GIFs posted as links", () => {
    const link = "https://tenor.com/view/cat-stare-gif-12345";
    // biome-ignore lint/style/useNamingConvention: this is discord.js's name for it
    const embeds = [{ thumbnail: { url: "https://media.tenor.com/a.png", proxyURL: "https://images-ext-1.discordapp.net/a.png" } }];

    it("reads a bare GIF link as a picture, keeping the link to post again", () => {
        expect(toChatMessage(discordMessage({ cleanContent: link, embeds }), SELF)).toMatchObject({
            text: "[image]",
            images: [{ url: "https://images-ext-1.discordapp.net/a.png", link }],
        });
    });

    it("has no picture to look at until Discord adds the preview", () => {
        const mapped = toChatMessage(discordMessage({ cleanContent: link }), SELF);
        expect(mapped?.text).toBe("[image]");
        expect(mapped?.images).toBeUndefined();
    });

    it("picks up the preview when it arrives as an edit", () => {
        expect(toLateImages(discordMessage({ cleanContent: link, embeds, partial: false }), SELF)).toEqual({
            platform: "discord",
            channelId: "c1",
            messageId: "m1",
            images: [{ url: "https://images-ext-1.discordapp.net/a.png", link }],
        });
    });

    it("ignores other edits and its own links", () => {
        expect(toLateImages(discordMessage({ cleanContent: "edited", partial: false }), SELF)).toBeUndefined();
        const own = { cleanContent: link, embeds, partial: false, author: { id: SELF, bot: true, displayName: "me" } };
        expect(toLateImages(discordMessage(own), SELF)).toBeUndefined();
    });

    it.each([`看这个 ${link}`, "https://example.com/view/cat-gif-1", "https://tenor.com.evil.example/view/a"])(
        "leaves %s as ordinary text",
        (cleanContent) => {
            const mapped = toChatMessage(discordMessage({ cleanContent, embeds }), SELF);
            expect(mapped?.text).toBe(cleanContent);
            expect(mapped?.images).toBeUndefined();
        },
    );
});

describe("forwarded messages", () => {
    it("reads what was forwarded without treating it as the sender's words", () => {
        expect(toChatMessage(forwardOf({ content: "看这个" }), SELF)).toMatchObject({
            text: "[forwarded messages]",
            forwarded: [{ text: "看这个" }],
        });
    });

    it("doesn't mistake a forward for a reply, even of the agent's own message", () => {
        const original = {
            id: "original",
            partial: false,
            author: { id: SELF, displayName: "me" },
            attachments: [],
            stickers: [],
            cleanContent: "x",
        };
        const channel = { messages: { cache: new Map([["original", original]]) } };
        const mapped = toChatMessage(forwardOf({ content: "x" }, { channel }), SELF);
        expect(mapped?.repliesToSelf).toBe(false);
        expect(mapped?.replyToMessageId).toBeUndefined();
        expect(mapped?.replyTo).toBeUndefined();
    });

    it("has pictures described through the forward's own text", () => {
        const image = { contentType: "image/png", size: 10, url: "https://cdn/a.png" };
        expect(toChatMessage(forwardOf({ attachments: new Collection([["a", image]]) }), SELF)).toMatchObject({
            text: "[forwarded messages] [image]",
            images: [{ url: "https://cdn/a.png" }],
            forwarded: [{ text: "[image]" }],
        });
    });

    it("shows anyone it can't name as someone, rather than a raw ID", () => {
        const channel = {
            messages: { cache: new Map() },
            guild: { members: { cache: new Map() } },
            client: { users: { cache: new Map() }, channels: { cache: new Map() } },
        };
        expect(toChatMessage(forwardOf({ content: "<@!123456789012345678> <#123456789012345678> 看" }, { channel }), SELF)?.forwarded).toEqual([
            { text: "@someone #some-channel 看" },
        ]);
    });

    it("still shows a forward it can't read", () => {
        const mapped = toChatMessage(forwardOf({ content: "" }), SELF);
        expect(mapped?.text).toBe("[forwarded messages]");
        expect(mapped?.forwarded).toBeUndefined();
    });

    it("previews a forward someone replies to", () => {
        const original = forwardOf({ content: "x" }, { id: "fwd" });
        const channel = { messages: { cache: new Map([["fwd", original]]) } };
        expect(toChatMessage(discordMessage({ reference: { messageId: "fwd" }, channel }), SELF)?.replyTo?.text).toBe("[forwarded messages]");
    });
});

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

    it("uploads a picture under a name that keeps a GIF animated, and pings nobody", async () => {
        const { sent, adapter } = setup();
        await adapter.sendImage(channel, { bytes: Uint8Array.of(1, 2), mime: "image/gif" });
        expect(sent[0]).toMatchObject({ files: [{ attachment: Buffer.of(1, 2), name: "image.gif" }], allowedMentions: { parse: [] } });
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
        expect(toSystemGroupEvent(discordMessage({ system: true, type: MessageType.ThreadCreated }), SELF)).toBeUndefined();
    });

    it("maps a boost, whatever level it took the server to", () => {
        for (const type of [MessageType.GuildBoost, MessageType.GuildBoostTier2]) {
            expect(toSystemGroupEvent(discordMessage({ system: true, type }), SELF)).toMatchObject({ kind: "boosted", actor: { id: "u1" } });
        }
    });
});

describe("toCommandEvent", () => {
    const user = { id: "u2", bot: false, displayName: "alice" };

    it("says who used which command above a bot's answer", () => {
        const answer = discordMessage({ interaction: { type: InteractionType.ApplicationCommand, commandName: "roll", user } });
        expect(toCommandEvent(answer)).toMatchObject({ kind: "command", actor: { id: "u2", displayName: "alice" }, detail: "roll", at: 1234 });
    });

    it("ignores ordinary messages and button presses", () => {
        expect(toCommandEvent(discordMessage())).toBeUndefined();
        expect(toCommandEvent(discordMessage({ interaction: { type: InteractionType.MessageComponent, commandName: "", user } }))).toBeUndefined();
    });
});

describe("cards", () => {
    const card = { title: "标题", description: "第一行\n第二行", fields: [], author: null };

    it("reads the card under a link", () => {
        expect(toChatMessage(discordMessage({ cleanContent: "https://example.com", embeds: [card] }), SELF)?.text).toBe(
            "https://example.com [card: 标题 · 第一行 第二行]",
        );
    });

    it("reads a bot's message that is only a card, fields included", () => {
        const embeds = [{ title: null, description: null, author: { name: "骰子" }, fields: [{ name: "结果", value: "4" }] }];
        expect(toChatMessage(discordMessage({ cleanContent: "", embeds }), SELF)?.text).toBe("[card: 骰子 · 结果: 4]");
    });

    it("skips a card with nothing to read, and still drops a message that is empty without one", () => {
        const embeds = [{ title: null, description: null, fields: [], author: null }];
        expect(toChatMessage(discordMessage({ cleanContent: "", embeds }), SELF)).toBeUndefined();
    });

    it("keeps a long card short and stops it closing its own bracket", () => {
        const text = toChatMessage(discordMessage({ cleanContent: "", embeds: [{ ...card, description: `a] [b ${"x".repeat(1000)}` }] }), SELF)?.text;
        expect(text?.startsWith("[card: 标题 · a b x")).toBe(true);
        expect(text?.length).toBeLessThan(320);
        expect(text?.match(/[[\]]/g)).toHaveLength(2);
    });
});

describe("toRevision", () => {
    it("reads an edit as the message is now", () => {
        const updated = discordMessage({ cleanContent: "后天见", partial: false, editedTimestamp: 2000 });
        expect(toRevision({ editedTimestamp: null }, updated, SELF)).toMatchObject({ edited: true, message: { messageId: "m1", text: "后天见" } });
    });

    it("doesn't call a card arriving late an edit, on a message never edited or one edited before", () => {
        const embeds = [{ title: "标题", description: null, fields: [], author: null }];
        const late = (editedTimestamp: number | null) =>
            toRevision({ editedTimestamp }, discordMessage({ cleanContent: "https://example.com", embeds, partial: false, editedTimestamp }), SELF);
        expect(late(null)).toMatchObject({ edited: false, message: { text: "https://example.com [card: 标题]" } });
        expect(late(2000)?.edited).toBe(false);
    });

    it("ignores its own messages and ones it can't read", () => {
        expect(toRevision({ editedTimestamp: null }, discordMessage({ partial: true }), SELF)).toBeUndefined();
        const own = discordMessage({ partial: false, editedTimestamp: 2000, author: { id: SELF, bot: true, displayName: "bot" } });
        expect(toRevision({ editedTimestamp: null }, own, SELF)).toBeUndefined();
    });
});

describe("deleted messages", () => {
    it("reports single and bulk deletions by ID, cached or not", async () => {
        const client = new EventEmitter() as EventEmitter & { login?: unknown; user?: unknown };
        client.user = { id: SELF };
        client.login = async () => client.emit(Events.ClientReady);
        const removals: unknown[] = [];
        const adapter = new DiscordAdapter({ token: "t", client: client as unknown as Client });
        await adapter.start(
            () => {},
            undefined,
            undefined,
            undefined,
            (removal) => removals.push(removal),
        );
        client.emit(Events.MessageDelete, { id: "m1", channelId: "c1", partial: true });
        client.emit(
            Events.MessageBulkDelete,
            new Collection([
                ["m2", {}],
                ["m3", {}],
            ]),
            { id: "c1" },
        );
        expect(removals).toEqual([
            { platform: "discord", channelId: "c1", messageIds: ["m1"] },
            { platform: "discord", channelId: "c1", messageIds: ["m2", "m3"] },
        ]);
    });
});

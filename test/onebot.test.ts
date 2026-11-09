// biome-ignore-all lint/style/useNamingConvention: these names are OneBot's wire format

import { describe, expect, it, vi } from "vitest";
import {
    emojiFromId,
    OneBotAdapter,
    type OneBotSocket,
    toChatMessage,
    toGroupEvent,
    toQuotedMessage,
    toReactionEvents,
} from "../src/adapters/onebot.ts";
import type { ChatMessage, GroupEvent, ReactionEvent, SendOptions } from "../src/adapters/types.ts";
import { ManualClock } from "../src/lib/clock.ts";

const NOW = 1_800_000_000_000;
const LOOKUP = { selfName: "小茜", names: new Map([["42", "bob"]]) };

function text(value: string) {
    return { type: "text", data: { text: value } };
}

function event(message: { type: string; data: Record<string, unknown> }[], overrides: Record<string, unknown> = {}) {
    return {
        self_id: "999",
        group_id: "181",
        user_id: "7",
        message_id: "55",
        time: NOW / 1000,
        message,
        sender: { nickname: "nick", card: "card" },
        ...overrides,
    };
}

function map(message: { type: string; data: Record<string, unknown> }[], overrides: Record<string, unknown> = {}, ownSends: string[] = []) {
    return toChatMessage(event(message, overrides) as never, NOW, LOOKUP, (id) => ownSends.includes(id));
}

class FakeSocket implements OneBotSocket {
    sent: { action: string; params: Record<string, unknown>; echo: string }[] = [];
    closed = false;
    #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

    send(data: string): void {
        this.sent.push(JSON.parse(data));
    }

    close(): void {
        this.closed = true;
    }

    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }

    emit(type: string, data?: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) });
    }

    /** Answers the newest call that hasn't been answered yet. */
    reply(data: unknown, status = "ok"): void {
        const call = this.sent.at(-1);
        this.emit("message", { status, retcode: status === "ok" ? 0 : 1400, data, wording: "nope", echo: call?.echo });
    }
}

async function lookupSent(socket: FakeSocket) {
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ action: "get_msg" }));
}

async function memberLookupSent(socket: FakeSocket) {
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ action: "get_group_member_info" }));
}

async function connected() {
    const clock = new ManualClock(NOW);
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const statuses: string[] = [];
    const messages: ChatMessage[] = [];
    const reactions: ReactionEvent[] = [];
    const groupEvents: GroupEvent[] = [];
    const adapter = new OneBotAdapter({
        url: "ws://napcat",
        clock,
        selfName: "小茜",
        onStatus: (status) => statuses.push(status),
        openSocket: (url) => {
            urls.push(url);
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
    });
    const started = adapter.start(
        (message) => messages.push(message),
        (reaction) => reactions.push(reaction),
        (groupEvent) => groupEvents.push(groupEvent),
    );
    const socket = sockets[0] as FakeSocket;
    socket.emit("open");
    socket.reply({ user_id: 999, nickname: "bot" });
    await Promise.resolve();
    await Promise.resolve();
    socket.reply([{ group_id: 181, group_name: "测试群" }]);
    await started;
    return { adapter, clock, sockets, socket, urls, statuses, messages, reactions, groupEvents };
}

describe("OneBot message mapping", () => {
    it("maps an ordinary group message, preferring the group card", () => {
        expect(map([text("hello")])).toEqual({
            platform: "qq",
            channelId: "181",
            messageId: "55",
            sender: { id: "7", displayName: "card", isBot: false },
            text: "hello",
            sentAt: NOW,
            mentionsSelf: false,
            repliesToSelf: false,
            isSelf: false,
            isBacklog: false,
        });
    });

    it("falls back to the nickname when there's no card", () => {
        expect(map([text("x")], { sender: { nickname: "nick", card: "" } })?.sender.displayName).toBe("nick");
    });

    it("notices being @-mentioned, but not @all", () => {
        const direct = map([{ type: "at", data: { qq: "999" } }, text(" 在吗")]);
        expect(direct).toMatchObject({ mentionsSelf: true, text: "@小茜 在吗" });
        expect(map([{ type: "at", data: { qq: "all" } }, text(" 开会")])).toMatchObject({ mentionsSelf: false, text: "@全体成员 开会" });
    });

    it("names other people who get mentioned", () => {
        expect(map([{ type: "at", data: { qq: "42" } }])?.text).toBe("@bob");
        expect(map([{ type: "at", data: { qq: "43", name: "carol" } }])?.text).toBe("@carol");
    });

    it("lists who else was mentioned, without itself or @all", () => {
        const message = map([
            { type: "at", data: { qq: "999" } },
            { type: "at", data: { qq: "all" } },
            { type: "at", data: { qq: "42" } },
            { type: "at", data: { qq: "43", name: "carol" } },
        ]);
        expect(message?.mentions).toEqual(["bob", "carol"]);
    });

    it("recognises a reply to something it sent", () => {
        const message = map([{ type: "reply", data: { id: "77" } }, text("真的吗")], {}, ["77"]);
        expect(message).toMatchObject({ repliesToSelf: true, replyToMessageId: "77", text: "真的吗" });
        expect(map([{ type: "reply", data: { id: "78" } }, text("x")], {}, ["77"])?.repliesToSelf).toBe(false);
    });

    it("keeps pictures for later and uses placeholders for other media", () => {
        const picture = map([{ type: "image", data: { url: "https://qq/pic", file_size: "1000" } }]);
        expect(picture).toMatchObject({ text: "[image]", images: [{ url: "https://qq/pic" }] });
        expect(map([{ type: "image", data: { url: "https://qq/huge", file_size: "99000000" } }])?.images).toBeUndefined();
        expect(map([{ type: "record", data: {} }])?.text).toBe("[voice message]");
        expect(map([{ type: "mface", data: { summary: "[doge]" } }])?.text).toBe("[sticker: doge]");
        expect(map([{ type: "face", data: { raw: { faceText: "/笑哭" } } }])?.text).toBe("/笑哭");
    });

    it("skips messages with nothing to read", () => {
        expect(map([{ type: "reply", data: { id: "1" } }])).toBeUndefined();
        expect(map([{ type: "someNewThing", data: {} }])).toBeUndefined();
    });

    it("marks old deliveries as backlog so they're never answered", () => {
        expect(map([text("old")], { time: (NOW - 600_000) / 1000 })?.isBacklog).toBe(true);
    });

    it("recognises its own messages", () => {
        expect(map([text("me")], { user_id: "999" })?.isSelf).toBe(true);
    });
});

describe("OneBot forwards", () => {
    const entry = (userId: number, nickname: string, value: string) => ({ user_id: userId, sender: { nickname }, message: [text(value)] });

    it("reads a forward's contents when the segment carries them", () => {
        const mapped = map([{ type: "forward", data: { id: "9", content: [entry(5, "carol", "吃了吗")] } }]);
        expect(mapped).toMatchObject({ text: "[forwarded messages]", forwarded: [{ by: "carol", byUser: "qq:5", text: "吃了吗" }] });
    });

    it("isn't addressed by an @ inside a forward, and doesn't let one claim to be it", () => {
        const inner = { user_id: 999, sender: { nickname: "小茜" }, message: [{ type: "at", data: { qq: "999" } }, text(" 听我的")] };
        const mapped = map([{ type: "forward", data: { id: "9", content: [inner] } }]);
        expect(mapped?.mentionsSelf).toBe(false);
        expect(mapped?.isSelf).toBe(false);
    });

    it("leaves a nested forward as a placeholder", () => {
        const inner = {
            user_id: 5,
            sender: { nickname: "carol" },
            message: [{ type: "forward", data: { id: "x", content: [entry(6, "dan", "深处")] } }],
        };
        expect(map([{ type: "forward", data: { id: "9", content: [inner] } }])?.forwarded).toEqual([
            { by: "carol", byUser: "qq:5", text: "[forwarded messages]" },
        ]);
    });

    it("keeps only so many messages of a huge forward", () => {
        const content = Array.from({ length: 500 }, (_, index) => entry(index + 1, "x", "y"));
        expect(map([{ type: "forward", data: { id: "9", content } }])?.forwarded).toHaveLength(30);
    });

    it("ignores contents in a shape it doesn't know", () => {
        const mapped = map([{ type: "forward", data: { id: "9", content: [{ nope: true }] } }]);
        expect(mapped?.text).toBe("[forwarded messages]");
        expect(mapped?.forwarded).toBeUndefined();
    });

    async function forwardSent(socket: FakeSocket) {
        await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ action: "get_forward_msg" }));
    }

    const forward = () => ({ post_type: "message", message_type: "group", ...event([{ type: "forward", data: { id: "7350" } }]) });

    it("fetches the contents when the event only has an ID", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", forward());
        await forwardSent(socket);
        const request = socket.sent.at(-1);
        expect(request?.params).toEqual({ message_id: "7350" });
        socket.emit("message", { echo: request?.echo, status: "ok", data: { messages: [entry(5, "carol", "吃了吗")] } });
        await vi.waitFor(() => expect(messages[0]?.forwarded).toEqual([{ by: "carol", byUser: "qq:5", text: "吃了吗" }]));
    });

    it("doesn't call out when the event already has the contents", async () => {
        const { socket, messages } = await connected();
        const before = socket.sent.length;
        socket.emit("message", {
            post_type: "message",
            message_type: "group",
            ...event([{ type: "forward", data: { id: "9", content: [entry(5, "c", "y")] } }]),
        });
        expect(messages).toHaveLength(1);
        expect(socket.sent).toHaveLength(before);
    });

    it("keeps the placeholder when the fetch fails", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", forward());
        await forwardSent(socket);
        socket.emit("message", { echo: socket.sent.at(-1)?.echo, status: "failed", retcode: 1400, wording: "消息已过期" });
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toMatchObject({ text: "[forwarded messages]" });
        expect(messages[0]?.forwarded).toBeUndefined();
    });

    it("holds later messages back until the forward is open, to keep the order", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", forward());
        await forwardSent(socket);
        socket.emit("message", { post_type: "message", message_type: "group", ...event([text("后来的")], { message_id: 2 }) });
        expect(messages).toHaveLength(0);
        socket.emit("message", { echo: socket.sent.at(-1)?.echo, status: "ok", data: { messages: [entry(5, "carol", "吃了吗")] } });
        await vi.waitFor(() => expect(messages.map(({ text: body }) => body)).toEqual(["[forwarded messages]", "后来的"]));
    });

    it("doesn't fetch a forward from backlog", async () => {
        const { socket, messages } = await connected();
        const before = socket.sent.length;
        socket.emit("message", {
            post_type: "message",
            message_type: "group",
            ...event([{ type: "forward", data: { id: "7350" } }], { time: NOW / 1000 - 600 }),
        });
        expect(messages).toHaveLength(1);
        expect(socket.sent).toHaveLength(before);
    });
});

describe("OneBot reactions", () => {
    it("reads Unicode reactions and QQ's own faces", () => {
        expect(emojiFromId("128077")).toBe("👍");
        expect(emojiFromId("76")).toBe("表情76");
        expect(emojiFromId("9728")).toBe("☀");
    });

    it("turns a notice into reaction events", () => {
        const notice = { self_id: "999", group_id: "181", user_id: "42", message_id: "55", likes: [{ emoji_id: "128077" }], is_add: false };
        expect(toReactionEvents(notice, LOOKUP.names)).toEqual([
            {
                platform: "qq",
                channelId: "181",
                messageId: "55",
                emoji: "👍",
                reactor: { id: "42", displayName: "bob", isBot: false },
                isSelf: false,
                removed: true,
            },
        ]);
    });
});

describe("OneBotAdapter", () => {
    it("learns the group names when it connects", async () => {
        const { adapter, statuses } = await connected();
        expect(statuses).toContain("connected");
        expect(adapter.channelName("181")).toBe("测试群");
    });

    it("passes group messages on and ignores private ones", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", { post_type: "message", message_type: "private", ...event([text("dm")]) });
        socket.emit("message", { post_type: "message", message_type: "group", ...event([text("hi")]) });
        expect(messages.map((message) => message.text)).toEqual(["hi"]);
    });

    it("passes reactions on", async () => {
        const { socket, reactions } = await connected();
        socket.emit("message", {
            post_type: "notice",
            notice_type: "group_msg_emoji_like",
            self_id: 999,
            group_id: 181,
            user_id: 7,
            message_id: 55,
            likes: [{ emoji_id: "128077", count: 1 }],
        });
        expect(reactions[0]).toMatchObject({ emoji: "👍", removed: false, channelId: "181" });
    });

    it("sends text as a segment, so CQ codes in it stay inert", async () => {
        const { adapter, socket } = await connected();
        const sending = adapter.send({ platform: "qq", channelId: "181" }, "[CQ:at,qq=all]");
        expect(socket.sent.at(-1)).toMatchObject({
            action: "send_group_msg",
            params: { group_id: 181, message: [{ type: "text", data: { text: "[CQ:at,qq=all]" } }] },
        });
        socket.reply({ message_id: 321 });
        expect(await sending).toEqual({ messageId: "321" });
    });

    it("sends a picture inline, since the server may not share this disk", async () => {
        const { adapter, socket } = await connected();
        const sending = adapter.sendImage({ platform: "qq", channelId: "181" }, { bytes: Uint8Array.of(1, 2, 3), mime: "image/gif" });
        expect(socket.sent.at(-1)).toMatchObject({
            action: "send_group_msg",
            params: { group_id: 181, message: [{ type: "image", data: { file: "base64://AQID" } }] },
        });
        socket.reply({ message_id: 322 });
        expect(await sending).toEqual({ messageId: "322" });
    });

    const sendText = async (body: string, options: SendOptions) => {
        const { adapter, socket } = await connected();
        const sending = adapter.send({ platform: "qq", channelId: "181" }, body, options);
        const message = socket.sent.at(-1)?.params.message;
        socket.reply({ message_id: 321 });
        await sending;
        return message;
    };

    it("turns a resolved mention into an at segment", async () => {
        await expect(sendText("喂 @bob 你看", { mention: { userId: "42", start: 2, end: 6 } })).resolves.toEqual([
            { type: "text", data: { text: "喂 " } },
            { type: "at", data: { qq: "42" } },
            { type: "text", data: { text: " 你看" } },
        ]);
    });

    it("leaves out empty text around a mention", async () => {
        await expect(sendText("@bob", { mention: { userId: "42", start: 0, end: 4 } })).resolves.toEqual([{ type: "at", data: { qq: "42" } }]);
    });

    it("drops a mention the length limit would cut through", async () => {
        const message = await sendText("x".repeat(5000), { mention: { userId: "42", start: 4500, end: 4504 } });
        expect(message).toEqual([{ type: "text", data: { text: "x".repeat(4000) } }]);
    });

    it("quotes when asked, and treats replies to its messages as addressed", async () => {
        const { adapter, socket, messages } = await connected();
        const sending = adapter.send({ platform: "qq", channelId: "181" }, "yes", { replyToMessageId: "55" });
        expect(socket.sent.at(-1)?.params.message).toEqual([
            { type: "reply", data: { id: "55" } },
            { type: "text", data: { text: "yes" } },
        ]);
        socket.reply({ message_id: 321 });
        await sending;
        socket.emit("message", { post_type: "message", message_type: "group", ...event([{ type: "reply", data: { id: "321" } }, text("ok")]) });
        await lookupSent(socket);
        socket.reply(null, "failed");
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]?.repliesToSelf).toBe(true);
    });

    describe("names of people @-mentioned", () => {
        const incoming = (segments: Parameters<typeof event>[0], overrides: Record<string, unknown> = {}) => ({
            post_type: "message",
            message_type: "group",
            ...event(segments),
            ...overrides,
        });
        const atStranger = [{ type: "at", data: { qq: "1507524536" } }, text(" 在吗")];

        it("looks up someone who hasn't spoken, so the chat shows a name and not a number", async () => {
            const { socket, messages } = await connected();
            socket.emit("message", incoming(atStranger));
            await memberLookupSent(socket);
            expect(socket.sent.at(-1)).toMatchObject({ params: { group_id: 181, user_id: 1507524536 } });
            expect(messages).toHaveLength(0);
            socket.reply({ card: "土豆" });
            await vi.waitFor(() => expect(messages).toHaveLength(1));
            expect(messages[0]).toMatchObject({ text: "@土豆 在吗", mentions: ["土豆"] });
        });

        it("remembers the name, so the next @ needs no lookup", async () => {
            const { socket, messages } = await connected();
            socket.emit("message", incoming(atStranger));
            await memberLookupSent(socket);
            socket.reply({ nickname: "土豆" });
            await vi.waitFor(() => expect(messages).toHaveLength(1));
            const callsBefore = socket.sent.length;
            socket.emit("message", incoming(atStranger, { message_id: 56 }));
            await vi.waitFor(() => expect(messages).toHaveLength(2));
            expect(socket.sent).toHaveLength(callsBefore);
        });

        it("still delivers with the number if the lookup fails or times out", async () => {
            const { socket, messages, clock } = await connected();
            socket.emit("message", incoming(atStranger));
            await memberLookupSent(socket);
            await clock.advance(3000);
            await vi.waitFor(() => expect(messages).toHaveLength(1));
            expect(messages[0]?.text).toBe("@1507524536 在吗");
        });

        it("keeps later messages behind the one being looked up", async () => {
            const { socket, messages } = await connected();
            socket.emit("message", incoming(atStranger));
            socket.emit("message", incoming([text("second")], { message_id: 56 }));
            await memberLookupSent(socket);
            expect(messages).toHaveLength(0);
            socket.reply({ card: "土豆" });
            await vi.waitFor(() => expect(messages.map((message) => message.text)).toEqual(["@土豆 在吗", "second"]));
        });

        it("doesn't look up @all, itself, or someone QQ already named", async () => {
            const { socket, messages } = await connected();
            const callsBefore = socket.sent.length;
            const segments = [
                { type: "at", data: { qq: "all" } },
                { type: "at", data: { qq: "999" } },
                { type: "at", data: { qq: "43", name: "carol" } },
            ];
            socket.emit("message", incoming(segments));
            expect(messages).toHaveLength(1);
            expect(socket.sent).toHaveLength(callsBefore);
        });

        it("makes no lookups for history replayed after being offline", async () => {
            const { socket, messages } = await connected();
            const callsBefore = socket.sent.length;
            socket.emit("message", incoming(atStranger, { time: NOW / 1000 - 600 }));
            expect(messages[0]?.isBacklog).toBe(true);
            expect(socket.sent).toHaveLength(callsBefore);
        });

        it("limits how many members one message can look up", async () => {
            const { socket } = await connected();
            const callsBefore = socket.sent.length;
            socket.emit("message", incoming(Array.from({ length: 20 }, (_, i) => ({ type: "at", data: { qq: String(5000 + i) } }))));
            await memberLookupSent(socket);
            expect(socket.sent.length - callsBefore).toBe(5);
        });
    });

    const quoteSegment = { type: "reply", data: { id: "55" } };
    const incoming = (message: { type: string; data: Record<string, unknown> }[], overrides: Record<string, unknown> = {}) => ({
        post_type: "message",
        message_type: "group",
        ...event(message, overrides),
    });
    const original = {
        message_id: 55,
        group_id: 181,
        user_id: 42,
        sender: { user_id: 42, nickname: "alice", card: "" },
        message: [text("吃了吗"), { type: "image", data: {} }],
    };

    it("looks up what a reply is quoting", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", incoming([quoteSegment, text("没")]));
        await lookupSent(socket);
        expect(socket.sent.at(-1)).toMatchObject({ params: { message_id: 55 } });
        socket.reply(original);
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toMatchObject({
            text: "没",
            replyToMessageId: "55",
            replyTo: { messageId: "55", by: "alice", byUser: "qq:42", text: "吃了吗[image]", isSelf: false },
        });
    });

    it("keeps messages in order while a quote is being looked up", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", incoming([quoteSegment, text("first")], { message_id: 1 }));
        socket.emit("message", incoming([text("second")], { message_id: 2 }));
        await lookupSent(socket);
        expect(messages).toHaveLength(0);
        socket.reply(original);
        await vi.waitFor(() => expect(messages.map((message) => message.text)).toEqual(["first", "second"]));
    });

    it("delivers a reply without its quote when the lookup fails or times out", async () => {
        const { socket, messages, clock } = await connected();
        socket.emit("message", incoming([quoteSegment, text("没")]));
        await lookupSent(socket);
        await clock.advance(3000);
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toMatchObject({ replyToMessageId: "55" });
        expect(messages[0]?.replyTo).toBeUndefined();
    });

    it("treats a reply to its own message as addressed even if it has forgotten sending it", async () => {
        const { socket, messages } = await connected();
        socket.emit("message", incoming([quoteSegment, text("真的吗")]));
        await lookupSent(socket);
        socket.reply({ ...original, user_id: Number(event([]).self_id) });
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toMatchObject({ repliesToSelf: true, replyTo: { isSelf: true } });
    });

    it("won't quote a message from another group, or one it can't attribute", () => {
        const context = { self_id: "999", group_id: "181" };
        const lookup = { selfName: "小茜", names: new Map() };
        expect(toQuotedMessage({ ...original, group_id: 7 }, "55", context, lookup)).toBeUndefined();
        expect(toQuotedMessage({ message: original.message, sender: {} }, "55", context, lookup)).toBeUndefined();
        expect(toQuotedMessage("nonsense", "55", context, lookup)).toBeUndefined();
    });

    it("reports a refused send and doesn't retry it", async () => {
        const { adapter, socket } = await connected();
        const before = socket.sent.length;
        const sending = adapter.send({ platform: "qq", channelId: "181" }, "x");
        socket.reply(null, "failed");
        await expect(sending).rejects.toThrow(/nope/);
        expect(socket.sent.length).toBe(before + 1);
    });

    it("gives up on a call that never gets an answer", async () => {
        const { adapter, clock } = await connected();
        const sending = adapter.send({ platform: "qq", channelId: "181" }, "x");
        const failure = expect(sending).rejects.toThrow(/timed out/);
        await clock.advance(20_000);
        await failure;
    });

    it("reacts with the configured emoji ID", async () => {
        const { adapter, socket } = await connected();
        const reacting = adapter.react({ platform: "qq", channelId: "181" }, "55", "76");
        expect(socket.sent.at(-1)).toMatchObject({ action: "set_msg_emoji_like", params: { message_id: "55", emoji_id: "76", set: true } });
        socket.reply(null);
        await reacting;
    });

    it("fails in-flight calls and reconnects with growing delays when the connection drops", async () => {
        const { adapter, clock, sockets, socket, statuses } = await connected();
        const sending = adapter.send({ platform: "qq", channelId: "181" }, "x");
        const failure = expect(sending).rejects.toThrow(/closed/);
        socket.emit("close");
        await failure;
        expect(statuses).toContain("disconnected");
        await clock.advance(1000);
        expect(sockets).toHaveLength(2);
        sockets[1]?.emit("close");
        await clock.advance(1000);
        expect(sockets).toHaveLength(2);
        await clock.advance(1000);
        expect(sockets).toHaveLength(3);
    });

    it("starts anyway when the server is down, so other platforms aren't held up", async () => {
        const clock = new ManualClock(NOW);
        const socket = new FakeSocket();
        const adapter = new OneBotAdapter({ url: "ws://napcat", clock, selfName: "小茜", openSocket: () => socket });
        const started = adapter.start(() => {});
        socket.emit("close");
        await expect(started).resolves.toBeUndefined();
        await adapter.stop();
    });

    it("stops for good when told to", async () => {
        const { adapter, clock, sockets, socket } = await connected();
        await adapter.stop();
        expect(socket.closed).toBe(true);
        socket.emit("close");
        await clock.advance(120_000);
        expect(sockets).toHaveLength(1);
    });

    it("puts the token in the address when there is one", async () => {
        const urls: string[] = [];
        const socket = new FakeSocket();
        const adapter = new OneBotAdapter({
            url: "ws://napcat",
            token: "a b",
            clock: new ManualClock(NOW),
            selfName: "小茜",
            openSocket: (url) => {
                urls.push(url);
                return socket;
            },
        });
        const started = adapter.start(() => {});
        socket.emit("close");
        await started;
        expect(urls).toEqual(["ws://napcat?access_token=a%20b"]);
    });
});

describe("OneBot group notices", () => {
    const names = new Map([
        ["7", "bob"],
        ["8", "admin"],
    ]);
    const notice = (overrides: Record<string, unknown>) =>
        ({ post_type: "notice", self_id: "999", group_id: "181", time: NOW / 1000, sub_type: "", duration: 0, ...overrides }) as never;
    const ban = { notice_type: "group_ban", sub_type: "ban", user_id: "7", operator_id: "8", duration: 600 };

    it("maps a mute with its length and who did it", () => {
        expect(toGroupEvent(notice(ban), NOW, names)).toMatchObject({
            platform: "qq",
            channelId: "181",
            kind: "muted",
            actor: { id: "8", displayName: "admin" },
            target: { id: "7", displayName: "bob" },
            targetIsSelf: false,
            durationMs: 600_000,
            at: NOW,
        });
    });

    it("maps lifting a mute", () => {
        expect(toGroupEvent(notice({ ...ban, sub_type: "lift_ban", duration: 0 }), NOW, names)).toMatchObject({
            kind: "unmuted",
            durationMs: undefined,
        });
    });

    it("recognizes a whole-group mute, which has no individual target", () => {
        const event = toGroupEvent(notice({ ...ban, user_id: "0", duration: -1 }), NOW, names);
        expect(event).toMatchObject({ kind: "muted_all", actor: { id: "8" }, target: undefined });
        expect(toGroupEvent(notice({ ...ban, user_id: "0", sub_type: "lift_ban" }), NOW, names)?.kind).toBe("unmuted_all");
    });

    it("notices when it's the one affected", () => {
        expect(toGroupEvent(notice({ ...ban, user_id: "999" }), NOW, names)?.targetIsSelf).toBe(true);
    });

    it("maps departures, keeping the operator only for a kick", () => {
        const decrease = { notice_type: "group_decrease", user_id: "7", operator_id: "8" };
        expect(toGroupEvent(notice({ ...decrease, sub_type: "kick" }), NOW, names)).toMatchObject({ kind: "kicked", actor: { id: "8" } });
        expect(toGroupEvent(notice({ ...decrease, sub_type: "leave" }), NOW, names)).toMatchObject({ kind: "left", actor: undefined });
    });

    it("maps joins and admin changes", () => {
        expect(
            toGroupEvent(notice({ notice_type: "group_increase", sub_type: "approve", user_id: "7", operator_id: "8" }), NOW, names),
        ).toMatchObject({
            kind: "joined",
            actor: undefined,
        });
        expect(toGroupEvent(notice({ notice_type: "group_admin", sub_type: "set", user_id: "7" }), NOW, names)?.kind).toBe("admin_added");
    });

    it("treats essence messages as pins", () => {
        const essence = { notice_type: "essence", sub_type: "add", sender_id: "7", operator_id: "8", message_id: "55" };
        expect(toGroupEvent(notice(essence), NOW, names)).toMatchObject({ kind: "pinned", actor: { id: "8" }, messageId: "55", targetIsSelf: false });
        expect(toGroupEvent(notice({ ...essence, sub_type: "delete" }), NOW, names)?.kind).toBe("unpinned");
    });

    it("ignores stale notices and ones it has no use for", () => {
        expect(toGroupEvent(notice({ ...ban, time: (NOW - 300_000) / 1000 }), NOW, names)).toBeUndefined();
        expect(toGroupEvent(notice({ notice_type: "group_upload" }), NOW, names)).toBeUndefined();
    });

    describe("pokes", () => {
        const poke = { notice_type: "notify", sub_type: "poke", user_id: "8", target_id: "7" };

        it("reads the poker from user_id and the one poked from target_id", () => {
            expect(toGroupEvent(notice(poke), NOW, names)).toMatchObject({
                kind: "poked",
                actor: { displayName: "admin" },
                target: { displayName: "bob" },
                targetIsSelf: false,
            });
        });

        it("knows when she's the one poked", () => {
            expect(toGroupEvent(notice({ ...poke, target_id: "999" }), NOW, names)?.targetIsSelf).toBe(true);
        });

        it("looks up the name of whoever was poked", async () => {
            const { socket, groupEvents } = await connected();
            socket.emit("message", { post_type: "notice", self_id: 999, group_id: 181, time: NOW / 1000, ...poke });
            const lookups = socket.sent.slice(-2);
            expect(lookups.map(({ params }) => params)).toEqual([
                { group_id: 181, user_id: 8 },
                { group_id: 181, user_id: 7 },
            ]);
            for (const [index, lookup] of lookups.entries()) {
                socket.emit("message", { status: "ok", retcode: 0, data: { nickname: `n${index}` }, echo: lookup.echo });
            }
            await vi.waitFor(() => expect(groupEvents).toHaveLength(1));
            expect(groupEvents[0]).toMatchObject({ actor: { displayName: "n0" }, target: { displayName: "n1" } });
        });

        it("ignores a private poke and other notifications without complaint", async () => {
            const { socket, groupEvents, statuses } = await connected();
            const before = socket.sent.length;
            socket.emit("message", { post_type: "notice", self_id: 999, time: NOW / 1000, ...poke });
            socket.emit("message", { post_type: "notice", self_id: 999, time: NOW / 1000, notice_type: "notify", sub_type: "profile_like" });
            socket.emit("message", { post_type: "notice", self_id: 999, group_id: 181, time: NOW / 1000, notice_type: "notify", sub_type: "honor" });
            expect(socket.sent).toHaveLength(before);
            expect(groupEvents).toHaveLength(0);
            expect(statuses.filter((status) => status.includes("message_failed"))).toEqual([]);
        });
    });

    it("looks up names it hasn't seen, and carries on if it can't", async () => {
        const { socket, groupEvents } = await connected();
        socket.emit("message", { post_type: "notice", self_id: 999, group_id: 181, time: NOW / 1000, ...ban });
        const [first, second] = socket.sent.slice(-2);
        expect(first).toMatchObject({ action: "get_group_member_info", params: { group_id: 181, user_id: 7 } });
        socket.emit("message", { status: "ok", retcode: 0, data: { card: "小明", nickname: "n" }, echo: first?.echo });
        socket.emit("message", { status: "failed", retcode: 1400, wording: "nope", echo: second?.echo });
        await vi.waitFor(() => expect(groupEvents).toHaveLength(1));
        expect(groupEvents[0]).toMatchObject({ target: { displayName: "小明" }, actor: { displayName: "8" } });
    });
});

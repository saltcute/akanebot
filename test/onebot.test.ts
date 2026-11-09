// biome-ignore-all lint/style/useNamingConvention: these names are OneBot's wire format
import { describe, expect, it, vi } from "vitest";
import { emojiFromId, OneBotAdapter, type OneBotSocket, toChatMessage, toGroupEvent, toReactionEvents } from "../src/adapters/onebot.ts";
import type { ChatMessage, GroupEvent, ReactionEvent } from "../src/adapters/types.ts";
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
        expect(messages[0]?.repliesToSelf).toBe(true);
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

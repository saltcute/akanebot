// biome-ignore-all lint/style/useNamingConvention: these names are OneBot's wire format
import { z } from "zod";
import type { CancelTimer, Clock } from "../lib/clock.ts";
import type { Adapter, ChannelRef, ChatMessage, ReactionEvent, SendOptions } from "./types.ts";

const MAX_MESSAGE_CHARS = 4000;
const MAX_DESCRIBABLE_IMAGE_BYTES = 5_000_000;
const CALL_TIMEOUT_MS = 15_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
const MAX_REMEMBERED_SENDS = 1000;
/** QQ can hand over messages from while the client was offline, and those must never be answered as if live. */
const MAX_LIVE_AGE_MS = 120_000;
/** QQ's own faces have small IDs. Anything above this is a Unicode code point, the lowest QQ uses being ☀ at 9728. */
const LAST_QQ_FACE_ID = 9727;

const idSchema = z.union([z.number(), z.string()]).transform(String);
const segmentSchema = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()).default({}) });

const groupMessageSchema = z.object({
    self_id: idSchema,
    group_id: idSchema,
    user_id: idSchema,
    message_id: idSchema,
    time: z.number(),
    message: z.array(segmentSchema),
    sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).default({}),
});

const reactionNoticeSchema = z.object({
    self_id: idSchema,
    group_id: idSchema,
    user_id: idSchema,
    message_id: idSchema,
    likes: z.array(z.object({ emoji_id: idSchema })),
    is_add: z.boolean().default(true),
});

type GroupMessage = z.infer<typeof groupMessageSchema>;
type ReactionNotice = z.infer<typeof reactionNoticeSchema>;
type Segment = z.infer<typeof segmentSchema>;

/** The part of a WebSocket this adapter uses, so tests can stand in for one. */
export type OneBotSocket = {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "close" | "message", listener: (event: { data?: unknown }) => void): void;
};

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; cancelTimeout: CancelTimer };

type Lookup = { selfName: string; names: ReadonlyMap<string, string> };

function asText(value: unknown): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function describeSegment({ type, data }: Segment, selfId: string, { selfName, names }: Lookup): string {
    switch (type) {
        case "text":
            return asText(data.text);
        case "at": {
            const target = asText(data.qq);
            if (target === "all") return "@全体成员";
            if (target === selfId) return `@${selfName}`;
            return `@${asText(data.name) || names.get(target) || target}`;
        }
        case "image":
            return "[image]";
        case "face": {
            const raw = data.raw as { faceText?: unknown } | undefined;
            return asText(raw?.faceText) || "[表情]";
        }
        case "mface":
            return `[sticker: ${asText(data.summary).replace(/[[\]]/g, "") || "表情包"}]`;
        case "record":
            return "[voice message]";
        case "video":
            return "[video]";
        case "file":
            return "[file]";
        case "forward":
            return "[forwarded messages]";
        case "json":
        case "xml":
            return "[shared card]";
        default:
            return "";
    }
}

function isDescribableImage({ type, data }: Segment): boolean {
    return type === "image" && asText(data.url) !== "" && Number(data.file_size ?? 0) <= MAX_DESCRIBABLE_IMAGE_BYTES;
}

function displayName(event: GroupMessage): string {
    return event.sender.card || event.sender.nickname || event.user_id;
}

/** Returns undefined for messages with nothing to read. */
export function toChatMessage(
    event: GroupMessage,
    now: number,
    lookup: Lookup,
    repliedToSelf: (messageId: string) => boolean,
): ChatMessage | undefined {
    const text = event.message
        .map((segment) => describeSegment(segment, event.self_id, lookup))
        .join("")
        .trim();
    if (text === "") return undefined;
    const images = event.message.filter(isDescribableImage).map(({ data }) => ({ url: asText(data.url) }));
    const replyTo = asText(event.message.find((segment) => segment.type === "reply")?.data.id);
    const sentAt = event.time * 1000;
    return {
        platform: "qq",
        channelId: event.group_id,
        messageId: event.message_id,
        sender: { id: event.user_id, displayName: displayName(event), isBot: false },
        text,
        ...(images.length > 0 ? { images } : {}),
        sentAt,
        // Compares against its own ID, so @全体成员 doesn't count as being addressed.
        mentionsSelf: event.message.some((segment) => segment.type === "at" && asText(segment.data.qq) === event.self_id),
        repliesToSelf: replyTo !== "" && repliedToSelf(replyTo),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        isSelf: event.user_id === event.self_id,
        isBacklog: now - sentAt > MAX_LIVE_AGE_MS,
    };
}

export function emojiFromId(id: string): string {
    const code = Number(id);
    return Number.isInteger(code) && code > LAST_QQ_FACE_ID && code <= 0x10ffff ? String.fromCodePoint(code) : `表情${id}`;
}

export function toReactionEvents(event: ReactionNotice, names: ReadonlyMap<string, string>): ReactionEvent[] {
    return event.likes.map(({ emoji_id }) => ({
        platform: "qq",
        channelId: event.group_id,
        messageId: event.message_id,
        emoji: emojiFromId(emoji_id),
        reactor: { id: event.user_id, displayName: names.get(event.user_id) ?? event.user_id, isBot: false },
        isSelf: event.user_id === event.self_id,
        removed: !event.is_add,
    }));
}

/** QQ through a OneBot 11 server such as NapCat, over its forward WebSocket. */
export class OneBotAdapter implements Adapter {
    readonly platform = "qq" as const;
    #url: string;
    #clock: Clock;
    #selfName: string;
    #onStatus: (status: string, detail?: string) => void;
    #openSocket: (url: string) => OneBotSocket;
    #socket: OneBotSocket | undefined;
    #onMessage: ((message: ChatMessage) => void) | undefined;
    #onReaction: ((event: ReactionEvent) => void) | undefined;
    #pending = new Map<string, Pending>();
    #nextEcho = 1;
    #retryMs = FIRST_RETRY_MS;
    #cancelRetry: CancelTimer | undefined;
    #stopped = false;
    #ownMessages = new Set<string>();
    #names = new Map<string, string>();
    #groupNames = new Map<string, string>();

    constructor(options: {
        url: string;
        token?: string | undefined;
        clock: Clock;
        selfName: string;
        onStatus?: (status: string, detail?: string) => void;
        openSocket?: (url: string) => OneBotSocket;
    }) {
        this.#url = options.token ? `${options.url}?access_token=${encodeURIComponent(options.token)}` : options.url;
        this.#clock = options.clock;
        this.#selfName = options.selfName;
        this.#onStatus = options.onStatus ?? (() => {});
        this.#openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as OneBotSocket);
    }

    /** Resolves after the first attempt either way, so a QQ outage can't stop other platforms from starting. It keeps retrying. */
    async start(onMessage: (message: ChatMessage) => void, onReaction?: (event: ReactionEvent) => void): Promise<void> {
        this.#stopped = false;
        this.#onMessage = onMessage;
        this.#onReaction = onReaction;
        await new Promise<void>((resolve) => this.#connect(resolve));
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        this.#cancelRetry?.();
        this.#socket?.close();
        this.#socket = undefined;
    }

    async send(channel: ChannelRef, text: string, options: SendOptions = {}): Promise<{ messageId: string }> {
        // Always the segment form, because in the plain string form model output could smuggle in a [CQ:at,qq=all].
        const message = [
            ...(options.replyToMessageId ? [{ type: "reply", data: { id: options.replyToMessageId } }] : []),
            { type: "text", data: { text: text.slice(0, MAX_MESSAGE_CHARS) } },
        ];
        const result = (await this.#call("send_group_msg", { group_id: Number(channel.channelId), message })) as { message_id: number | string };
        const messageId = String(result.message_id);
        this.#ownMessages.add(messageId);
        if (this.#ownMessages.size > MAX_REMEMBERED_SENDS) this.#ownMessages.delete(this.#ownMessages.values().next().value ?? "");
        return { messageId };
    }

    /** QQ shows no typing indicator in groups. */
    async sendTyping(): Promise<void> {}

    /** `emojiId` is a face ID, or a decimal code point for the Unicode emoji QQ supports. */
    async react(_channel: ChannelRef, messageId: string, emojiId: string): Promise<void> {
        await this.#call("set_msg_emoji_like", { message_id: messageId, emoji_id: emojiId, set: true });
    }

    channelName(channelId: string): string | undefined {
        return this.#groupNames.get(channelId);
    }

    #connect(settled?: () => void): void {
        const socket = this.#openSocket(this.#url);
        this.#socket = socket;
        socket.addEventListener("open", () => {
            this.#retryMs = FIRST_RETRY_MS;
            void this.#loadIdentity().finally(() => settled?.());
        });
        socket.addEventListener("message", (event) => this.#onData(event.data));
        socket.addEventListener("close", () => {
            this.#failPendingCalls();
            settled?.();
            if (this.#stopped || this.#socket !== socket) return;
            this.#onStatus("disconnected", `retrying in ${Math.round(this.#retryMs / 1000)}s`);
            this.#cancelRetry = this.#clock.setTimer(this.#retryMs, () => this.#connect());
            this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
        });
    }

    async #loadIdentity(): Promise<void> {
        try {
            const login = (await this.#call("get_login_info", {})) as { user_id: number | string };
            this.#onStatus("connected", String(login.user_id));
            const groups = (await this.#call("get_group_list", {})) as { group_id: number | string; group_name: string }[];
            for (const group of groups) this.#groupNames.set(String(group.group_id), group.group_name);
        } catch (error) {
            this.#onStatus("error", String(error));
        }
    }

    #call(action: string, params: Record<string, unknown>): Promise<unknown> {
        const socket = this.#socket;
        if (!socket) return Promise.reject(new Error("Not connected to the OneBot server"));
        const echo = String(this.#nextEcho++);
        return new Promise((resolve, reject) => {
            const cancelTimeout = this.#clock.setTimer(CALL_TIMEOUT_MS, () => {
                this.#pending.delete(echo);
                reject(new Error(`OneBot ${action} timed out`));
            });
            this.#pending.set(echo, { resolve, reject, cancelTimeout });
            socket.send(JSON.stringify({ action, params, echo }));
        });
    }

    #failPendingCalls(): void {
        for (const { reject, cancelTimeout } of this.#pending.values()) {
            cancelTimeout();
            reject(new Error("Connection to the OneBot server closed"));
        }
        this.#pending.clear();
    }

    #onData(data: unknown): void {
        try {
            const payload = JSON.parse(String(data)) as Record<string, unknown>;
            if (payload.echo !== undefined) this.#onResponse(payload);
            else if (payload.post_type === "message" && payload.message_type === "group") this.#onGroupMessage(groupMessageSchema.parse(payload));
            else if (payload.post_type === "notice" && payload.notice_type === "group_msg_emoji_like") {
                for (const event of toReactionEvents(reactionNoticeSchema.parse(payload), this.#names)) this.#onReaction?.(event);
            }
        } catch (error) {
            this.#onStatus("message_failed", String(error));
        }
    }

    #onResponse(payload: Record<string, unknown>): void {
        const echo = String(payload.echo);
        const pending = this.#pending.get(echo);
        if (!pending) return;
        this.#pending.delete(echo);
        pending.cancelTimeout();
        if (payload.status === "ok" || payload.retcode === 0) pending.resolve(payload.data);
        else pending.reject(new Error(`OneBot call failed: ${asText(payload.wording) || asText(payload.message) || asText(payload.retcode)}`));
    }

    #onGroupMessage(event: GroupMessage): void {
        this.#names.set(event.user_id, displayName(event));
        const lookup = { selfName: this.#selfName, names: this.#names };
        const message = toChatMessage(event, this.#clock.now(), lookup, (id) => this.#ownMessages.has(id));
        if (message) this.#onMessage?.(message);
    }
}

// biome-ignore-all lint/style/useNamingConvention: these names are OneBot's wire format
import { z } from "zod";
import type { CancelTimer, Clock } from "../lib/clock.ts";
import type {
    Adapter,
    ChannelRef,
    ChatMessage,
    ForwardedLine,
    GroupEvent,
    GroupEventKind,
    OutgoingImage,
    OutgoingMention,
    QuotedMessage,
    ReactionEvent,
    Sender,
    SendOptions,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 4000;
const MAX_DESCRIBABLE_IMAGE_BYTES = 5_000_000;
const CALL_TIMEOUT_MS = 15_000;
/** Everything behind a reply or an unfamiliar @ waits for this lookup, so it gives up sooner than other calls. */
const LOOKUP_TIMEOUT_MS = 3000;
/** Someone can @ the whole member list, and only so many of those are worth a call each. */
const MAX_NAME_LOOKUPS_PER_MESSAGE = 5;
/** A forward can hold hundreds of messages, and only the start of one gets read. */
const MAX_FORWARDED_LINES = 30;
/** Forwards nest as deep as someone cares to make them, so everything inside the first level shares these limits. */
const MAX_FORWARD_DEPTH = 4;
const MAX_NESTED_FORWARDED_LINES = 100;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
const MAX_REMEMBERED_SENDS = 1000;
/** QQ can hand over messages from while the client was offline, and those must never be answered as if live. */
const MAX_LIVE_AGE_MS = 120_000;
/** QQ's own faces have small IDs. Anything above this is a Unicode code point, the lowest QQ uses being ☀ at 9728. */
const LAST_QQ_FACE_ID = 9727;
/** Stands in for a person: the target of a whole-group mute, or an operator the server couldn't identify. */
const NOBODY = "0";
const NOTICE_KINDS: Readonly<Record<string, GroupEventKind>> = {
    "group_ban/ban": "muted",
    "group_ban/lift_ban": "unmuted",
    "group_decrease/leave": "left",
    "group_decrease/kick": "kicked",
    "group_decrease/kick_me": "kicked",
    "group_increase/approve": "joined",
    "group_increase/invite": "joined",
    "group_admin/set": "admin_added",
    "group_admin/unset": "admin_removed",
    "essence/add": "pinned",
    "essence/delete": "unpinned",
    "notify/poke": "poked",
};

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

const fetchedMessageSchema = z.object({
    group_id: idSchema.optional(),
    user_id: idSchema.optional(),
    message: z.array(segmentSchema),
    sender: z.object({ user_id: idSchema.optional(), nickname: z.string().optional(), card: z.string().optional() }).default({}),
});

const reactionNoticeSchema = z.object({
    self_id: idSchema,
    group_id: idSchema,
    user_id: idSchema,
    message_id: idSchema,
    likes: z.array(z.object({ emoji_id: idSchema })),
    is_add: z.boolean().default(true),
});

const groupNoticeSchema = z.object({
    self_id: idSchema,
    group_id: idSchema,
    time: z.number(),
    notice_type: z.string(),
    sub_type: z.string().default(""),
    user_id: idSchema.optional(),
    operator_id: idSchema.optional(),
    target_id: idSchema.optional(),
    message_id: idSchema.optional(),
    duration: z.number().default(0),
});

type GroupNotice = z.infer<typeof groupNoticeSchema>;
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

function mentionedName(data: Segment["data"], target: string, names: Lookup["names"]): string {
    return asText(data.name) || names.get(target) || target;
}

function describeSegment({ type, data }: Segment, selfId: string, { selfName, names }: Lookup): string {
    switch (type) {
        case "text":
            return asText(data.text);
        case "at": {
            const target = asText(data.qq);
            if (target === "all") return "@全体成员";
            if (target === selfId) return `@${selfName}`;
            return `@${mentionedName(data, target, names)}`;
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

function mentionedOthers(segments: readonly Segment[], selfId: string, names: Lookup["names"]): string[] {
    return segments.flatMap(({ type, data }) => {
        const target = asText(data.qq);
        return type === "at" && target !== "all" && target !== selfId ? [mentionedName(data, target, names)] : [];
    });
}

function textSegment(text: string): Segment[] {
    return text === "" ? [] : [{ type: "text", data: { text } }];
}

/** A mention cut off by the length limit is dropped rather than sent half-formed. */
function outgoingSegments(fullText: string, mention: OutgoingMention | undefined): Segment[] {
    const text = fullText.slice(0, MAX_MESSAGE_CHARS);
    if (!mention || mention.end > text.length) return textSegment(text);
    return [...textSegment(text.slice(0, mention.start)), { type: "at", data: { qq: mention.userId } }, ...textSegment(text.slice(mention.end))];
}

/** People @-mentioned who QQ didn't name and who haven't spoken since startup, so all there is to show for them is a QQ number. */
function unnamedMentions(segments: readonly Segment[], selfId: string, names: Lookup["names"]): string[] {
    const targets = segments.flatMap(({ type, data }) => {
        const target = asText(data.qq);
        return type === "at" && target !== "" && target !== "all" && target !== selfId && !asText(data.name) && !names.has(target) ? [target] : [];
    });
    return [...new Set(targets)].slice(0, MAX_NAME_LOOKUPS_PER_MESSAGE);
}

function isDescribableImage({ type, data }: Segment): boolean {
    return type === "image" && asText(data.url) !== "" && Number(data.file_size ?? 0) <= MAX_DESCRIBABLE_IMAGE_BYTES;
}

function isUnopenedForward({ type, data }: Segment): boolean {
    return type === "forward" && data.content === undefined;
}

function displayName(event: GroupMessage): string {
    return event.sender.card || event.sender.nickname || event.user_id;
}

/** Reads a forward's contents, from the segment or from `get_forward_msg`. A forward inside it is read too when QQ includes its contents. Returns nothing if the shape is unfamiliar. */
export function toForwardedLines(data: unknown, selfId: string, lookup: Lookup): ForwardedLine[] {
    return readForward(data, selfId, lookup, 0, { left: MAX_NESTED_FORWARDED_LINES });
}

function readForward(data: unknown, selfId: string, lookup: Lookup, depth: number, nested: { left: number }): ForwardedLine[] {
    const parsed = z.array(fetchedMessageSchema).safeParse(data);
    if (!parsed.success) return [];
    const entries = parsed.data.slice(0, depth === 0 ? MAX_FORWARDED_LINES : Math.min(MAX_FORWARDED_LINES, nested.left));
    if (depth > 0) nested.left -= entries.length;
    return entries.flatMap(({ user_id: topLevelId, message, sender }) => {
        const text = message
            .map((segment) => describeSegment(segment, selfId, lookup))
            .join("")
            .trim();
        if (text === "") return [];
        const author = topLevelId ?? sender.user_id;
        const images = message.filter(isDescribableImage).map(({ data }) => ({ url: asText(data.url) }));
        const inner =
            depth < MAX_FORWARD_DEPTH
                ? readForward(message.find(({ type }) => type === "forward")?.data.content, selfId, lookup, depth + 1, nested)
                : [];
        return [
            {
                by: sender.card || sender.nickname || (author && lookup.names.get(author)) || author,
                byUser: author && `qq:${author}`,
                text,
                ...(images.length > 0 ? { images } : {}),
                ...(inner.length > 0 ? { forwarded: inner } : {}),
            },
        ];
    });
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
    const mentions = mentionedOthers(event.message, event.self_id, lookup.names);
    const forwarded = toForwardedLines(event.message.find(({ type }) => type === "forward")?.data.content, event.self_id, lookup);
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
        ...(mentions.length > 0 ? { mentions } : {}),
        repliesToSelf: replyTo !== "" && repliedToSelf(replyTo),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(forwarded.length > 0 ? { forwarded } : {}),
        isSelf: event.user_id === event.self_id,
        isBacklog: now - sentAt > MAX_LIVE_AGE_MS,
    };
}

/** Reads a `get_msg` result. Returns undefined if it can't say who wrote it, since a quote has to be attributable to be forgettable. */
export function toQuotedMessage(
    data: unknown,
    messageId: string,
    context: { self_id: string; group_id: string },
    lookup: Lookup,
): QuotedMessage | undefined {
    const parsed = fetchedMessageSchema.safeParse(data);
    if (!parsed.success) return undefined;
    const { group_id: groupId, user_id: topLevelId, message, sender } = parsed.data;
    const author = topLevelId ?? sender.user_id;
    if (!author || (groupId !== undefined && groupId !== context.group_id)) return undefined;
    const text = message
        .map((segment) => describeSegment(segment, context.self_id, lookup))
        .join("")
        .trim();
    if (text === "") return undefined;
    return {
        messageId,
        by: sender.card || sender.nickname || lookup.names.get(author) || author,
        byUser: `qq:${author}`,
        text,
        isSelf: author === context.self_id,
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

function noticeKey(notice: { notice_type?: unknown; sub_type?: unknown }): string {
    return `${String(notice.notice_type)}/${String(notice.sub_type)}`;
}

/** A poke in a private chat arrives the same way as one in a group, just with no group to parse. */
function isGroupNoticeWeRead(payload: Record<string, unknown>): boolean {
    return payload.post_type === "notice" && payload.group_id !== undefined && NOTICE_KINDS[noticeKey(payload)] !== undefined;
}

/** Returns undefined for notices it has no use for, and for stale ones replayed after being offline. */
export function toGroupEvent(notice: GroupNotice, now: number, names: ReadonlyMap<string, string>): GroupEvent | undefined {
    const at = notice.time * 1000;
    const individual = NOTICE_KINDS[noticeKey(notice)];
    if (!individual || now - at > MAX_LIVE_AGE_MS) return undefined;
    const person = (id: string | undefined): Sender | undefined =>
        id && id !== NOBODY ? { id, displayName: names.get(id) ?? id, isBot: false } : undefined;
    const wholeGroup = notice.notice_type === "group_ban" && notice.user_id === NOBODY;
    const kind = wholeGroup ? (individual === "muted" ? "muted_all" : "unmuted_all") : individual;
    // In a poke `user_id` is who did it, where every other notice has that person being acted on.
    const [actorId, targetId] = kind === "poked" ? [notice.user_id, notice.target_id] : [notice.operator_id, notice.user_id];
    return {
        platform: "qq",
        channelId: notice.group_id,
        kind,
        // On a join or a departure this is whoever approved it, or the person themselves, which nobody in the chat sees.
        actor: kind === "left" || kind === "joined" ? undefined : person(actorId),
        target: person(targetId),
        targetIsSelf: targetId === notice.self_id,
        durationMs: kind === "muted" ? notice.duration * 1000 : undefined,
        messageId: notice.message_id,
        at,
    };
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
    #onGroupEvent: ((event: GroupEvent) => void) | undefined;
    #pending = new Map<string, Pending>();
    #nextEcho = 1;
    #retryMs = FIRST_RETRY_MS;
    #cancelRetry: CancelTimer | undefined;
    #stopped = false;
    #ownMessages = new Set<string>();
    #names = new Map<string, string>();
    #groupNames = new Map<string, string>();
    #inbound: Promise<void> | undefined;

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
    async start(
        onMessage: (message: ChatMessage) => void,
        onReaction?: (event: ReactionEvent) => void,
        onGroupEvent?: (event: GroupEvent) => void,
    ): Promise<void> {
        this.#stopped = false;
        this.#onMessage = onMessage;
        this.#onReaction = onReaction;
        this.#onGroupEvent = onGroupEvent;
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
        return this.#post(channel, outgoingSegments(text, options.mention), options);
    }

    /** Sent inline, because the OneBot server may not be able to see this machine's disk. */
    async sendImage(channel: ChannelRef, image: OutgoingImage, options: SendOptions = {}): Promise<{ messageId: string }> {
        return this.#post(channel, [{ type: "image", data: { file: `base64://${Buffer.from(image.bytes).toString("base64")}` } }], options);
    }

    async #post(channel: ChannelRef, segments: readonly Segment[], options: SendOptions): Promise<{ messageId: string }> {
        const message = [...(options.replyToMessageId ? [{ type: "reply", data: { id: options.replyToMessageId } }] : []), ...segments];
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

    #call(action: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
        const socket = this.#socket;
        if (!socket) return Promise.reject(new Error("Not connected to the OneBot server"));
        const echo = String(this.#nextEcho++);
        return new Promise((resolve, reject) => {
            const cancelTimeout = this.#clock.setTimer(timeoutMs, () => {
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
            } else if (isGroupNoticeWeRead(payload)) {
                void this.#onGroupNotice(groupNoticeSchema.parse(payload)).catch((error) => this.#onStatus("message_failed", String(error)));
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

    async #onGroupNotice(notice: GroupNotice): Promise<void> {
        await Promise.all([notice.user_id, notice.operator_id, notice.target_id].map((id) => this.#learnName(notice.group_id, id)));
        const event = toGroupEvent(notice, this.#clock.now(), this.#names);
        if (event) this.#onGroupEvent?.(event);
    }

    /** Admins and people being removed often haven't spoken lately, and a bare QQ number would mean nothing in the chat. */
    async #learnName(groupId: string, userId: string | undefined, timeoutMs = CALL_TIMEOUT_MS): Promise<void> {
        if (!userId || userId === NOBODY || this.#names.has(userId)) return;
        try {
            const member = (await this.#call("get_group_member_info", { group_id: Number(groupId), user_id: Number(userId) }, timeoutMs)) as {
                card?: string;
                nickname?: string;
            };
            const name = member.card || member.nickname;
            if (name) this.#names.set(userId, name);
        } catch {
            // Someone who has just left can't be looked up, and the event still matters without a name.
        }
    }

    #onGroupMessage(event: GroupMessage): void {
        this.#names.set(event.user_id, displayName(event));
        const now = this.#clock.now();
        const convert = () => toChatMessage(event, now, { selfName: this.#selfName, names: this.#names }, (id) => this.#ownMessages.has(id));
        const isLive = now - event.time * 1000 <= MAX_LIVE_AGE_MS;
        const unnamed = isLive ? unnamedMentions(event.message, event.self_id, this.#names) : [];
        const isReply = event.message.some(({ type }) => type === "reply");
        const opensForward = isLive && event.message.some(isUnopenedForward);
        if (unnamed.length === 0 && !isReply && !opensForward && !this.#inbound) {
            const message = convert();
            if (message) this.#onMessage?.(message);
            return;
        }
        // QQ gives only an ID for a reply's target, a forward's contents and most @s, and looking one up takes a moment. Whatever arrives meanwhile waits, to keep the chat in order.
        const turn: Promise<void> = (this.#inbound ?? Promise.resolve())
            .then(() => Promise.all(unnamed.map((id) => this.#learnName(event.group_id, id, LOOKUP_TIMEOUT_MS))))
            .then(async () => {
                const message = convert();
                if (message) this.#onMessage?.(await this.#withForwarded(await this.#withQuote(message, event), event));
            })
            .catch((error) => this.#onStatus("message_failed", String(error)))
            .finally(() => {
                if (this.#inbound === turn) this.#inbound = undefined;
            });
        this.#inbound = turn;
    }

    /** A withdrawn or expired message can't be looked up, and the reply is still worth reading without it. */
    async #withQuote(message: ChatMessage, event: GroupMessage): Promise<ChatMessage> {
        const id = message.replyToMessageId;
        if (!id || message.isBacklog) return message;
        try {
            const data = await this.#call("get_msg", { message_id: Number(id) }, LOOKUP_TIMEOUT_MS);
            const replyTo = toQuotedMessage(data, id, event, { selfName: this.#selfName, names: this.#names });
            // Its record of its own sends is lost on restart, but QQ still knows who wrote the original.
            return replyTo ? { ...message, replyTo, repliesToSelf: message.repliesToSelf || replyTo.isSelf } : message;
        } catch {
            return message;
        }
    }

    /** A forward that's expired or too slow to open still shows up, as a placeholder. */
    async #withForwarded(message: ChatMessage, event: GroupMessage): Promise<ChatMessage> {
        const id = asText(event.message.find(isUnopenedForward)?.data.id);
        if (id === "" || message.isBacklog) return message;
        try {
            const data = (await this.#call("get_forward_msg", { message_id: id }, LOOKUP_TIMEOUT_MS)) as { messages?: unknown };
            const forwarded = toForwardedLines(data.messages, event.self_id, { selfName: this.#selfName, names: this.#names });
            return forwarded.length > 0 ? { ...message, forwarded } : message;
        } catch {
            return message;
        }
    }
}

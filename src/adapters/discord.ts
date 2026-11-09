import {
    AuditLogEvent,
    Client,
    cleanContent,
    Events,
    GatewayIntentBits,
    type Guild,
    type GuildAuditLogsEntry,
    type Message,
    type MessageReaction,
    MessageReferenceType,
    type MessageSnapshot,
    MessageType,
    Partials,
    type User,
} from "discord.js";
import type {
    Adapter,
    ChannelRef,
    ChatMessage,
    ForwardedLine,
    GroupEvent,
    GroupEventKind,
    OutgoingMention,
    QuotedMessage,
    ReactionEvent,
    Sender,
    SendOptions,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 2000;
const MAX_DESCRIBABLE_IMAGE_BYTES = 5_000_000;

function isDescribableImage(contentType: string | null, size: number): boolean {
    return Boolean(contentType?.startsWith("image/")) && size <= MAX_DESCRIBABLE_IMAGE_BYTES;
}

function mediaPlaceholders(message: Pick<Message, "attachments" | "stickers">): string[] {
    return [
        ...message.attachments.map((attachment) => (attachment.contentType?.startsWith("image/") ? "[image]" : "[file]")),
        ...message.stickers.map((sticker) => (sticker.name ? `[sticker: ${sticker.name}]` : "[sticker]")),
    ];
}

function isForward(message: Message): boolean {
    return message.reference?.type === MessageReferenceType.Forward;
}

function forwardSnapshot(message: Message): MessageSnapshot | undefined {
    return isForward(message) ? message.messageSnapshots.first() : undefined;
}

function describableImages(message: Pick<Message, "attachments">): { url: string }[] {
    return message.attachments.filter((attachment) => isDescribableImage(attachment.contentType, attachment.size)).map(({ url }) => ({ url }));
}

/** A forward's own text is empty. An `[image]` is left for the captioner, which writes into a message's own text. */
function readableText(message: Message): string {
    if (isForward(message)) {
        const snapshot = forwardSnapshot(message);
        return snapshot && describableImages(snapshot).length > 0 ? "[forwarded messages] [image]" : "[forwarded messages]";
    }
    return [message.cleanContent, ...mediaPlaceholders(message)].filter(Boolean).join(" ");
}

/** Names resolve against this channel's server, since the source channel may be one the bot can't see. Anyone not found there has no name to show. */
function forwardedLines(message: Message): ForwardedLine[] {
    const snapshot = forwardSnapshot(message);
    if (!snapshot) return [];
    const content = cleanContent(snapshot.content, message.channel)
        .replace(/<@[!&]?\d+>/g, "@someone")
        .replace(/<#\d+>/g, "#some-channel");
    const text = [content, ...mediaPlaceholders(snapshot)].filter(Boolean).join(" ");
    return text === "" ? [] : [{ text }];
}

/** The names `cleanContent` writes after each @. A reply that pings its author lists them too, even with no @ in the text. */
function mentionedNames(message: Message, selfId: string): string[] {
    return [...message.mentions.users]
        .filter(([id]) => id !== selfId)
        .map(([id, user]) => message.mentions.members?.get(id)?.displayName ?? user.displayName);
}

function toQuotedMessage(message: Message, selfId: string): QuotedMessage | undefined {
    const text = readableText(message);
    if (text === "") return undefined;
    return {
        messageId: message.id,
        by: message.member?.displayName ?? message.author.displayName,
        byUser: `discord:${message.author.id}`,
        text,
        isSelf: message.author.id === selfId,
    };
}

/** Returns undefined for anything that isn't an ordinary message in a server. */
export function toChatMessage(message: Message, selfId: string): ChatMessage | undefined {
    if (!message.inGuild() || message.system) return undefined;
    const text = readableText(message);
    if (text === "") return undefined;

    const snapshot = forwardSnapshot(message);
    const images = describableImages(snapshot ?? message);
    const forwarded = forwardedLines(message);
    // A forward points at its source through the same field as a reply, but it isn't answering anything.
    const repliedToId = isForward(message) ? undefined : message.reference?.messageId;
    // The gateway sends the original along with a reply, so it's cached by now. A reaction can leave a partial with no author or text.
    const cached = repliedToId ? message.channel.messages.cache.get(repliedToId) : undefined;
    const repliedTo = cached?.partial ? undefined : cached;
    const quoted = repliedTo ? toQuotedMessage(repliedTo, selfId) : undefined;
    const mentions = mentionedNames(message, selfId);
    return {
        platform: "discord",
        channelId: message.channelId,
        messageId: message.id,
        sender: {
            id: message.author.id,
            displayName: message.member?.displayName ?? message.author.displayName,
            isBot: message.author.bot,
        },
        text,
        ...(images.length > 0 ? { images } : {}),
        sentAt: message.createdTimestamp,
        // Checks the user list directly, so @everyone doesn't count as being addressed.
        mentionsSelf: message.mentions.users.has(selfId),
        ...(mentions.length > 0 ? { mentions } : {}),
        repliesToSelf: repliedTo?.author.id === selfId || message.mentions.repliedUser?.id === selfId,
        ...(repliedToId ? { replyToMessageId: repliedToId } : {}),
        ...(quoted ? { replyTo: quoted } : {}),
        ...(forwarded.length > 0 ? { forwarded } : {}),
        isSelf: message.author.id === selfId,
        // The gateway only delivers live events and never replays history after a reconnect.
        isBacklog: false,
    };
}

/** Works on partial objects: a reaction may be on a message the client has never cached. */
export function toReactionEvent(
    reaction: Pick<MessageReaction, "emoji" | "message">,
    user: User,
    selfId: string,
    removed: boolean,
): ReactionEvent | undefined {
    const emoji = reaction.emoji.name;
    if (!emoji || !reaction.message.guildId) return undefined;
    return {
        platform: "discord",
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        emoji,
        reactor: {
            id: user.id,
            displayName: reaction.message.guild?.members.cache.get(user.id)?.displayName ?? user.displayName,
            isBot: Boolean(user.bot),
        },
        isSelf: user.id === selfId,
        removed,
    };
}

/** Discord posts pins and joins in the channel as system messages. Returns undefined for any other system message. */
export function toSystemGroupEvent(message: Message, selfId: string): GroupEvent | undefined {
    if (!message.inGuild() || !message.system) return undefined;
    const author = {
        id: message.author.id,
        displayName: message.member?.displayName ?? message.author.displayName,
        isBot: message.author.bot,
    };
    const base = { platform: "discord", channelId: message.channelId, at: message.createdTimestamp } as const;
    if (message.type === MessageType.ChannelPinnedMessage) {
        return { ...base, kind: "pinned", actor: author, targetIsSelf: false, messageId: message.reference?.messageId };
    }
    if (message.type === MessageType.UserJoin) return { ...base, kind: "joined", target: author, targetIsSelf: author.id === selfId };
    return undefined;
}

type AuditFacts = { kind: GroupEventKind; durationMs?: number; channelId?: string; messageId?: string };

/** Timeouts arrive as a generic member update, told apart by which field changed. Returns undefined for everything else in the log. */
export function readAuditEntry(entry: Pick<GuildAuditLogsEntry, "action" | "changes" | "extra" | "createdTimestamp">): AuditFacts | undefined {
    switch (entry.action) {
        case AuditLogEvent.MemberKick:
            return { kind: "kicked" };
        case AuditLogEvent.MemberBanAdd:
            return { kind: "banned" };
        case AuditLogEvent.MemberBanRemove:
            return { kind: "unbanned" };
        case AuditLogEvent.MessageUnpin: {
            const { channel, messageId } = entry.extra as { channel: { id: string }; messageId: string };
            return { kind: "unpinned", channelId: channel.id, messageId };
        }
        case AuditLogEvent.MemberUpdate: {
            const timeout = entry.changes.find((change) => change.key === "communication_disabled_until");
            if (!timeout) return undefined;
            return timeout.new ? { kind: "muted", durationMs: Date.parse(String(timeout.new)) - entry.createdTimestamp } : { kind: "unmuted" };
        }
        default:
            return undefined;
    }
}

function withMention(text: string, mention: OutgoingMention | undefined): string {
    return mention ? `${text.slice(0, mention.start)}<@${mention.userId}>${text.slice(mention.end)}` : text;
}

export function createDiscordClient(): Client {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
            // Delivers audit log entries. Unlike GuildMembers it isn't privileged, but the bot needs View Audit Log in the server.
            GatewayIntentBits.GuildModeration,
        ],
        // Without these, reactions on messages sent before the bot started are never delivered.
        partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    });
}

export class DiscordAdapter implements Adapter {
    readonly platform = "discord" as const;
    #client: Client;
    #token: string;
    #onStatus: (status: string, detail?: string) => void;

    constructor(options: { token: string; client?: Client; onStatus?: (status: string, detail?: string) => void }) {
        this.#token = options.token;
        this.#client = options.client ?? createDiscordClient();
        this.#onStatus = options.onStatus ?? (() => {});
    }

    get botTag(): string | undefined {
        return this.#client.user?.tag;
    }

    async start(
        onMessage: (message: ChatMessage) => void,
        onReaction?: (event: ReactionEvent) => void,
        onGroupEvent?: (event: GroupEvent) => void,
    ): Promise<void> {
        const client = this.#client;
        const handleReaction = async (
            reaction: Pick<MessageReaction, "emoji" | "message">,
            user: User | { partial: true; fetch(): Promise<User> },
            removed: boolean,
        ) => {
            try {
                const selfId = client.user?.id;
                const fullUser = user.partial ? await user.fetch() : user;
                const event = selfId ? toReactionEvent(reaction, fullUser, selfId, removed) : undefined;
                if (event) onReaction?.(event);
            } catch (error) {
                this.#onStatus("reaction_failed", String(error));
            }
        };
        client.on(Events.MessageReactionAdd, (reaction, user) => void handleReaction(reaction, user as User, false));
        client.on(Events.MessageReactionRemove, (reaction, user) => void handleReaction(reaction, user as User, true));
        client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
            void this.#onAuditEntry(entry, guild, onGroupEvent).catch((error) => this.#onStatus("group_event_failed", String(error)));
        });
        client.on(Events.MessageCreate, (message) => {
            try {
                const selfId = client.user?.id;
                const event = selfId ? toSystemGroupEvent(message, selfId) : undefined;
                if (event) onGroupEvent?.(event);
                const mapped = selfId ? toChatMessage(message, selfId) : undefined;
                if (mapped) onMessage(mapped);
            } catch (error) {
                this.#onStatus("message_failed", String(error));
            }
        });
        client.on(Events.Error, (error) => this.#onStatus("error", error.message));
        client.on(Events.ShardDisconnect, (event) => this.#onStatus("disconnected", String(event.code)));
        client.on(Events.ShardResume, () => this.#onStatus("reconnected"));
        const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
        await client.login(this.#token);
        await ready;
    }

    async stop(): Promise<void> {
        await this.#client.destroy();
    }

    async send(channel: ChannelRef, text: string, options: SendOptions = {}): Promise<{ messageId: string }> {
        const target = await this.#sendable(channel);
        const sent = await target.send({
            content: withMention(text, options.mention).slice(0, MAX_MESSAGE_CHARS),
            // Nothing the model typed can ping anyone, least of all @everyone. Only the person code resolved gets notified.
            allowedMentions: { parse: [], ...(options.mention ? { users: [options.mention.userId] } : {}) },
            ...(options.replyToMessageId ? { reply: { messageReference: options.replyToMessageId, failIfNotExists: false } } : {}),
        });
        return { messageId: sent.id };
    }

    async sendTyping(channel: ChannelRef): Promise<void> {
        await (await this.#sendable(channel)).sendTyping();
    }

    async react(channel: ChannelRef, messageId: string, emoji: string): Promise<void> {
        const target = await this.#sendable(channel);
        await target.messages.react(messageId, emoji);
    }

    channelName(channelId: string): string | undefined {
        const channel = this.#client.channels.cache.get(channelId);
        if (!channel || !("name" in channel) || !channel.name) return undefined;
        return "guild" in channel ? `${channel.guild.name} #${channel.name}` : `#${channel.name}`;
    }

    /** Most of these are server-wide, so every channel gets one and the runtime keeps those on the allowlist. */
    async #onAuditEntry(entry: GuildAuditLogsEntry, guild: Guild, onGroupEvent?: (event: GroupEvent) => void): Promise<void> {
        const facts = readAuditEntry(entry);
        if (!facts) return;
        const targetId = facts.kind === "unpinned" ? null : entry.targetId;
        const [actor, target] = await Promise.all([this.#person(guild, entry.executorId), this.#person(guild, targetId)]);
        const channelIds = facts.channelId ? [facts.channelId] : guild.channels.cache.filter((channel) => channel.isTextBased()).map(({ id }) => id);
        for (const channelId of channelIds) {
            onGroupEvent?.({
                platform: "discord",
                channelId,
                kind: facts.kind,
                actor,
                target,
                targetIsSelf: targetId !== null && targetId === this.#client.user?.id,
                durationMs: facts.durationMs,
                messageId: facts.messageId,
                at: entry.createdTimestamp,
            });
        }
    }

    /** Someone who was just kicked or banned is no longer a member, but is still a user. */
    async #person(guild: Guild, id: string | null): Promise<Sender | undefined> {
        if (!id) return undefined;
        const member = await guild.members.fetch(id).catch(() => undefined);
        const user = member?.user ?? (await this.#client.users.fetch(id).catch(() => undefined));
        return { id, displayName: member?.displayName ?? user?.displayName ?? id, isBot: Boolean(user?.bot) };
    }

    async #sendable(channel: ChannelRef) {
        const target = await this.#client.channels.fetch(channel.channelId);
        if (!target?.isSendable()) throw new Error(`Discord channel ${channel.channelId} can't be sent to`);
        return target;
    }
}

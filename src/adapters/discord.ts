import {
    Client,
    cleanContent,
    type Embed,
    Events,
    GatewayIntentBits,
    InteractionType,
    type Message,
    type MessageReaction,
    MessageReferenceType,
    type MessageSnapshot,
    MessageType,
    type PartialMessage,
    Partials,
    type User,
} from "discord.js";
import type {
    Adapter,
    ChannelRef,
    ChatImage,
    ChatMessage,
    ForwardedLine,
    GroupEvent,
    LateImages,
    MessageRemoval,
    MessageRevision,
    OutgoingImage,
    OutgoingMention,
    QuotedMessage,
    ReactionEvent,
    SendOptions,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 2000;
const MAX_DESCRIBABLE_IMAGE_BYTES = 5_000_000;
const MAX_EMBEDS_READ = 2;
const MAX_EMBED_CHARS = 300;
const BOOSTS: readonly MessageType[] = [
    MessageType.GuildBoost,
    MessageType.GuildBoostTier1,
    MessageType.GuildBoostTier2,
    MessageType.GuildBoostTier3,
];
/** What the GIF picker posts: only a link, which Discord plays by itself. */
const GIF_LINK =
    /^https:\/\/(?:(?:www\.)?tenor\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?view\/|media\d*\.tenor\.com\/|(?:www\.)?giphy\.com\/gifs\/|media\d*\.giphy\.com\/)\S+$/;

function isDescribableImage(contentType: string | null, size: number): boolean {
    return Boolean(contentType?.startsWith("image/")) && size <= MAX_DESCRIBABLE_IMAGE_BYTES;
}

function mediaPlaceholders(message: Pick<Message, "attachments" | "stickers">): string[] {
    return [
        ...message.attachments.map((attachment) => (attachment.contentType?.startsWith("image/") ? "[image]" : "[file]")),
        ...message.stickers.map((sticker) => (sticker.name ? `[sticker: ${sticker.name}]` : "[sticker]")),
    ];
}

/**
 * The card under a link, or what a bot posts in place of text. A card that's only a picture or a video has nothing to read.
 * Flattened and stripped of brackets, so nothing in a card can close the placeholder it sits in.
 */
function embedCards(message: { embeds?: readonly Pick<Embed, "title" | "description" | "fields" | "author">[] }): string[] {
    return (message.embeds ?? []).slice(0, MAX_EMBEDS_READ).flatMap((embed) => {
        const parts = [embed.author?.name, embed.title, embed.description, ...(embed.fields ?? []).map(({ name, value }) => `${name}: ${value}`)];
        const text = parts
            .filter(Boolean)
            .join(" · ")
            .replace(/[[\]\s]+/g, " ")
            .trim()
            .slice(0, MAX_EMBED_CHARS);
        return text === "" ? [] : [`[card: ${text}]`];
    });
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

function isGifLink(message: Pick<Message, "cleanContent" | "attachments" | "stickers">): boolean {
    return GIF_LINK.test(message.cleanContent.trim()) && mediaPlaceholders(message).length === 0;
}

/** Undefined until Discord has fetched the preview, which is often a moment after the message arrives. */
function gifLinkImage(message: Message): ChatImage | undefined {
    if (!isGifLink(message)) return undefined;
    const preview = message.embeds.find((embed) => embed.thumbnail)?.thumbnail;
    return preview ? { url: preview.proxyURL ?? preview.url, link: message.cleanContent.trim() } : undefined;
}

/** A forward's own text is empty. An `[image]` is left for the captioner, which writes into a message's own text. */
function readableText(message: Message): string {
    if (isForward(message)) {
        const snapshot = forwardSnapshot(message);
        return snapshot && describableImages(snapshot).length > 0 ? "[forwarded messages] [image]" : "[forwarded messages]";
    }
    if (isGifLink(message)) return "[image]";
    return [message.cleanContent, ...mediaPlaceholders(message), ...embedCards(message)].filter(Boolean).join(" ");
}

/** Names resolve against this channel's server, since the source channel may be one the bot can't see. Anyone not found there has no name to show. */
function forwardedLines(message: Message): ForwardedLine[] {
    const snapshot = forwardSnapshot(message);
    if (!snapshot) return [];
    const content = cleanContent(snapshot.content, message.channel)
        .replace(/<@[!&]?\d+>/g, "@someone")
        .replace(/<#\d+>/g, "#some-channel");
    const text = [content, ...mediaPlaceholders(snapshot), ...embedCards(snapshot)].filter(Boolean).join(" ");
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
    const gif = snapshot ? undefined : gifLinkImage(message);
    const images = gif ? [gif] : describableImages(snapshot ?? message);
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
            accountName: message.author.username,
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

/** A GIF's preview usually turns up as an edit. Returns undefined for every other kind of edit. */
export function toLateImages(message: Message | PartialMessage, selfId: string): LateImages | undefined {
    if (message.partial || message.author.id === selfId) return undefined;
    const gif = gifLinkImage(message);
    return gif ? { platform: "discord", channelId: message.channelId, messageId: message.id, images: [gif] } : undefined;
}

/**
 * An edit, or Discord adding a link's card a moment after delivery. Pins and other updates come through here too and change nothing she reads.
 * Returns undefined when there's nothing left to read.
 */
export function toRevision(
    old: Pick<Message | PartialMessage, "editedTimestamp">,
    updated: Message | PartialMessage,
    selfId: string,
): MessageRevision | undefined {
    if (updated.partial) return undefined;
    const message = toChatMessage(updated, selfId);
    if (!message || message.isSelf) return undefined;
    return { message, edited: updated.editedTimestamp !== null && updated.editedTimestamp !== old.editedTimestamp };
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

/** Discord posts pins, joins and boosts in the channel as system messages. Returns undefined for any other system message. */
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
    if (BOOSTS.includes(message.type)) return { ...base, kind: "boosted", actor: author, targetIsSelf: false };
    return undefined;
}

/** The "alice used /roll" Discord shows above a bot's answer to a command. Returns undefined for every other message. */
export function toCommandEvent(message: Message): GroupEvent | undefined {
    // The newer field doesn't carry the command's name.
    const used = message.interaction;
    if (!message.inGuild() || !used || used.type !== InteractionType.ApplicationCommand) return undefined;
    return {
        platform: "discord",
        channelId: message.channelId,
        kind: "command",
        actor: {
            id: used.user.id,
            displayName: message.guild?.members.cache.get(used.user.id)?.displayName ?? used.user.displayName,
            isBot: Boolean(used.user.bot),
        },
        targetIsSelf: false,
        detail: used.commandName,
        at: message.createdTimestamp,
    };
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
        onLateImages?: (event: LateImages) => void,
        onRemoved?: (event: MessageRemoval) => void,
        onRevised?: (event: MessageRevision) => void,
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
        client.on(Events.MessageCreate, (message) => {
            try {
                const selfId = client.user?.id;
                const event = selfId ? (toSystemGroupEvent(message, selfId) ?? toCommandEvent(message)) : undefined;
                if (event) onGroupEvent?.(event);
                const mapped = selfId ? toChatMessage(message, selfId) : undefined;
                if (mapped) onMessage(mapped);
            } catch (error) {
                this.#onStatus("message_failed", String(error));
            }
        });
        client.on(Events.MessageUpdate, (old, updated) => {
            try {
                const selfId = client.user?.id;
                const event = selfId ? toLateImages(updated as Message | PartialMessage, selfId) : undefined;
                if (event) onLateImages?.(event);
                const revision = selfId ? toRevision(old, updated, selfId) : undefined;
                if (revision) onRevised?.(revision);
            } catch (error) {
                this.#onStatus("message_failed", String(error));
            }
        });
        // Deleting leaves no trace in the channel, so there's nothing to show, only something to stop seeing.
        client.on(Events.MessageDelete, ({ id, channelId }) => onRemoved?.({ platform: "discord", channelId, messageIds: [id] }));
        client.on(Events.MessageBulkDelete, (messages, channel) => {
            onRemoved?.({ platform: "discord", channelId: channel.id, messageIds: [...messages.keys()] });
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

    async sendImage(channel: ChannelRef, image: OutgoingImage, options: SendOptions = {}): Promise<{ messageId: string }> {
        const target = await this.#sendable(channel);
        const sent = await target.send({
            // The extension is what makes Discord play a GIF.
            files: [{ attachment: Buffer.from(image.bytes), name: `image.${image.mime.split("/")[1]}` }],
            allowedMentions: { parse: [] },
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

    async #sendable(channel: ChannelRef) {
        const target = await this.#client.channels.fetch(channel.channelId);
        if (!target?.isSendable()) throw new Error(`Discord channel ${channel.channelId} can't be sent to`);
        return target;
    }
}

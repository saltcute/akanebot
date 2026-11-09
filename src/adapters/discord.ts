import { Client, Events, GatewayIntentBits, type Message, type MessageReaction, Partials, type User } from "discord.js";
import type { Adapter, ChannelRef, ChatMessage, ReactionEvent, SendOptions } from "./types.ts";

const MAX_MESSAGE_CHARS = 2000;
const MAX_DESCRIBABLE_IMAGE_BYTES = 5_000_000;

function isDescribableImage(contentType: string | null, size: number): boolean {
    return Boolean(contentType?.startsWith("image/")) && size <= MAX_DESCRIBABLE_IMAGE_BYTES;
}

/** Returns undefined for anything that isn't an ordinary message in a server. */
export function toChatMessage(message: Message, selfId: string): ChatMessage | undefined {
    if (!message.inGuild() || message.system) return undefined;
    const placeholders = [
        ...message.attachments.map((attachment) => (attachment.contentType?.startsWith("image/") ? "[image]" : "[file]")),
        ...message.stickers.map((sticker) => (sticker.name ? `[sticker: ${sticker.name}]` : "[sticker]")),
    ];
    const text = [message.cleanContent, ...placeholders].filter(Boolean).join(" ");
    if (text === "") return undefined;

    const images = [
        ...message.attachments
            .filter((attachment) => isDescribableImage(attachment.contentType, attachment.size))
            .map((attachment) => ({ url: attachment.url })),
    ];
    const repliedToId = message.reference?.messageId;
    const repliedTo = repliedToId ? message.channel.messages.cache.get(repliedToId) : undefined;
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
        repliesToSelf: repliedTo?.author.id === selfId || message.mentions.repliedUser?.id === selfId,
        ...(repliedToId ? { replyToMessageId: repliedToId } : {}),
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

    async start(onMessage: (message: ChatMessage) => void, onReaction?: (event: ReactionEvent) => void): Promise<void> {
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
            content: text.slice(0, MAX_MESSAGE_CHARS),
            // Model output must never ping anyone, least of all @everyone.
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

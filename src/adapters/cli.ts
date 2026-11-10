import type { Clock } from "../lib/clock.ts";
import type {
    Adapter,
    ChannelRef,
    ChatMessage,
    ForwardedLine,
    GroupEvent,
    LateImages,
    MessageRemoval,
    MessageRevision,
    OutgoingImage,
    QuotedMessage,
    ReactionEvent,
    SendOptions,
} from "./types.ts";

const SELF_ID = "akanebot";
/** Platforms mark a mention as one unit, so whole tokens are read here too and `@akane2` isn't `@akane`. */
const MENTION_TOKEN = /(?<!\S)@([^\s,.!?，。！？:：]+)/gu;

/** A simulated group chat, driven by the simulator and by tests. */
export class CliAdapter implements Adapter {
    readonly platform = "cli" as const;
    readonly sent: { channelId: string; text: string; messageId: string; replyToMessageId?: string }[] = [];
    readonly sentImages: { channelId: string; messageId: string; image: OutgoingImage }[] = [];
    readonly reactions: { messageId: string; emoji: string }[] = [];
    readonly #clock: Clock;
    readonly #selfName: string;
    /** Keeps IDs unique across simulator runs that share a database. */
    readonly #idPrefix: string;
    readonly #ownNames: ReadonlySet<string>;
    readonly #print: (line: string) => void;
    #onMessage: ((message: ChatMessage) => void) | undefined;
    #onReaction: ((event: ReactionEvent) => void) | undefined;
    #onGroupEvent: ((event: GroupEvent) => void) | undefined;
    #onLateImages: ((event: LateImages) => void) | undefined;
    #onRemoved: ((event: MessageRemoval) => void) | undefined;
    #onRevised: ((event: MessageRevision) => void) | undefined;
    #said = new Map<string, ChatMessage>();
    #displayNames = new Map<string, string>();
    #nextId = 1;

    constructor(options: { clock: Clock; selfName: string; aliases?: readonly string[]; print?: (line: string) => void; idPrefix?: string }) {
        this.#clock = options.clock;
        this.#selfName = options.selfName;
        this.#idPrefix = options.idPrefix ?? "";
        this.#ownNames = new Set([options.selfName, ...(options.aliases ?? [])].map((name) => name.toLowerCase()));
        this.#print = options.print ?? (() => {});
    }

    async start(
        onMessage: (message: ChatMessage) => void,
        onReaction?: (event: ReactionEvent) => void,
        onGroupEvent?: (event: GroupEvent) => void,
        onLateImages?: (event: LateImages) => void,
        onRemoved?: (event: MessageRemoval) => void,
        onRevised?: (event: MessageRevision) => void,
    ): Promise<void> {
        this.#onMessage = onMessage;
        this.#onReaction = onReaction;
        this.#onGroupEvent = onGroupEvent;
        this.#onLateImages = onLateImages;
        this.#onRemoved = onRemoved;
        this.#onRevised = onRevised;
    }

    async stop(): Promise<void> {
        this.#onMessage = undefined;
    }

    /** Someone in the simulated group says something. Returns the new message's ID. */
    say(speaker: string, rawText: string, channelId = "group", replyTo?: QuotedMessage, forwarded?: readonly ForwardedLine[]): string {
        const messageId = `${this.#idPrefix}m${this.#nextId++}`;
        // "[img:https://...]" stands in for attaching a picture, and "[gif:https://...]" for a GIF that's only a link.
        const images = [
            ...[...rawText.matchAll(/\[img:(\S+?)\]/g)].flatMap((match) => (match[1] ? [{ url: match[1] }] : [])),
            ...[...rawText.matchAll(/\[gif:(\S+?)\]/g)].flatMap((match) => (match[1] ? [{ url: match[1], link: match[1] }] : [])),
        ];
        const text = rawText.replace(/\[(?:img|gif):\S+?\]/g, "[image]");
        const mentioned = [...text.matchAll(MENTION_TOKEN)].flatMap((match) => (match[1] ? [match[1]] : []));
        const mentionsSelf = mentioned.some((name) => this.#ownNames.has(name.toLowerCase()));
        const mentions = mentioned.filter((name) => !this.#ownNames.has(name.toLowerCase()));
        const message: ChatMessage = {
            platform: this.platform,
            channelId,
            messageId,
            sender: { id: speaker, displayName: this.#displayNames.get(speaker) ?? speaker, isBot: false },
            text,
            ...(images.length > 0 ? { images } : {}),
            sentAt: this.#clock.now(),
            mentionsSelf,
            ...(mentions.length > 0 ? { mentions } : {}),
            repliesToSelf: false,
            ...(replyTo ? { replyTo, replyToMessageId: replyTo.messageId } : {}),
            ...(forwarded ? { forwarded } : {}),
            isSelf: false,
            isBacklog: false,
        };
        this.#said.set(messageId, message);
        this.#onMessage?.(message);
        return messageId;
    }

    /** Someone changes the name they go by. Nothing shows until they next speak. */
    rename(speaker: string, displayName: string): void {
        this.#displayNames.set(speaker, displayName);
    }

    /** Someone deletes messages, theirs or as a moderator. */
    remove(messageIds: readonly string[], channelId = "group"): void {
        this.#onRemoved?.({ platform: this.platform, channelId, messageIds });
    }

    /** A message's text changes after it was sent. `edited` is false for something the platform filled in, such as a link's preview. */
    revise(messageId: string, text: string, edited = true): void {
        const message = this.#said.get(messageId);
        if (message) this.#onRevised?.({ message: { ...message, text }, edited });
    }

    /** The platform works out a message's picture after delivering it. */
    lateImages(messageId: string, images: LateImages["images"], channelId = "group"): void {
        this.#onLateImages?.({ platform: this.platform, channelId, messageId, images });
    }

    /** Someone in the simulated group reacts to a message. */
    reactFrom(speaker: string, messageId: string, emoji: string, removed = false, channelId = "group"): void {
        this.#onReaction?.({
            platform: this.platform,
            channelId,
            messageId,
            emoji,
            reactor: { id: speaker, displayName: speaker, isBot: false },
            isSelf: false,
            removed,
        });
    }

    /** Something happens in the simulated group, such as someone being muted. */
    groupEvent(event: Omit<GroupEvent, "platform" | "channelId" | "at" | "targetIsSelf"> & { targetIsSelf?: boolean }, channelId = "group"): void {
        this.#onGroupEvent?.({ targetIsSelf: false, ...event, platform: this.platform, channelId, at: this.#clock.now() });
    }

    async send(channel: ChannelRef, text: string, options: SendOptions = {}): Promise<{ messageId: string }> {
        const messageId = `${this.#idPrefix}m${this.#nextId++}`;
        this.sent.push({
            channelId: channel.channelId,
            text,
            messageId,
            ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
        });
        this.#print(`${this.#selfName}: ${text}`);
        this.#echo(channel, messageId, text);
        return { messageId };
    }

    async sendImage(channel: ChannelRef, image: OutgoingImage): Promise<{ messageId: string }> {
        const messageId = `${this.#idPrefix}m${this.#nextId++}`;
        this.sentImages.push({ channelId: channel.channelId, messageId, image });
        this.#print(`${this.#selfName}: [sends a ${image.mime} picture, ${image.bytes.length} bytes]`);
        this.#echo(channel, messageId, "[image]");
        return { messageId };
    }

    /** Real platforms echo the agent's own messages back, so the simulator does too. */
    #echo(channel: ChannelRef, messageId: string, text: string): void {
        this.#onMessage?.({
            platform: this.platform,
            channelId: channel.channelId,
            messageId,
            sender: { id: SELF_ID, displayName: this.#selfName, isBot: false },
            text,
            sentAt: this.#clock.now(),
            mentionsSelf: false,
            repliesToSelf: false,
            isSelf: true,
            isBacklog: false,
        });
    }

    async sendTyping(): Promise<void> {}

    async react(_channel: ChannelRef, messageId: string, emoji: string): Promise<void> {
        this.reactions.push({ messageId, emoji });
        this.#print(`${this.#selfName} reacted ${emoji} to ${messageId}`);
    }
}

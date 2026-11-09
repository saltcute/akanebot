import type { Clock } from "../lib/clock.ts";
import type { Adapter, ChannelRef, ChatMessage, ReactionEvent, SendOptions } from "./types.ts";

const SELF_ID = "akanebot";

/** A simulated group chat, driven by the simulator and by tests. */
export class CliAdapter implements Adapter {
    readonly platform = "cli" as const;
    readonly sent: { channelId: string; text: string; messageId: string; replyToMessageId?: string }[] = [];
    readonly reactions: { messageId: string; emoji: string }[] = [];
    readonly #clock: Clock;
    readonly #selfName: string;
    /** Keeps IDs unique across simulator runs that share a database. */
    readonly #idPrefix: string;
    readonly #mentions: readonly string[];
    readonly #print: (line: string) => void;
    #onMessage: ((message: ChatMessage) => void) | undefined;
    #onReaction: ((event: ReactionEvent) => void) | undefined;
    #nextId = 1;

    constructor(options: { clock: Clock; selfName: string; aliases?: readonly string[]; print?: (line: string) => void; idPrefix?: string }) {
        this.#clock = options.clock;
        this.#selfName = options.selfName;
        this.#idPrefix = options.idPrefix ?? "";
        this.#mentions = [options.selfName, ...(options.aliases ?? [])].map((name) => `@${name.toLowerCase()}`);
        this.#print = options.print ?? (() => {});
    }

    async start(onMessage: (message: ChatMessage) => void, onReaction?: (event: ReactionEvent) => void): Promise<void> {
        this.#onMessage = onMessage;
        this.#onReaction = onReaction;
    }

    async stop(): Promise<void> {
        this.#onMessage = undefined;
    }

    /** Someone in the simulated group says something. Returns the new message's ID. */
    say(speaker: string, rawText: string, channelId = "group"): string {
        const messageId = `${this.#idPrefix}m${this.#nextId++}`;
        // "[img:https://...]" stands in for attaching a picture.
        const images = [...rawText.matchAll(/\[img:(\S+?)\]/g)].flatMap((match) => (match[1] ? [{ url: match[1] }] : []));
        const text = rawText.replace(/\[img:\S+?\]/g, "[image]");
        const lowered = text.toLowerCase();
        const mentionsSelf = this.#mentions.some((mention) => lowered.includes(mention));
        this.#onMessage?.({
            platform: this.platform,
            channelId,
            messageId,
            sender: { id: speaker, displayName: speaker, isBot: false },
            text,
            ...(images.length > 0 ? { images } : {}),
            sentAt: this.#clock.now(),
            mentionsSelf,
            repliesToSelf: false,
            isSelf: false,
            isBacklog: false,
        });
        return messageId;
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

    async send(channel: ChannelRef, text: string, options: SendOptions = {}): Promise<{ messageId: string }> {
        const messageId = `${this.#idPrefix}m${this.#nextId++}`;
        this.sent.push({
            channelId: channel.channelId,
            text,
            messageId,
            ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
        });
        this.#print(`${this.#selfName}: ${text}`);
        // Real platforms echo the agent's own messages back, so the simulator does too.
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
        return { messageId };
    }

    async sendTyping(): Promise<void> {}

    async react(_channel: ChannelRef, messageId: string, emoji: string): Promise<void> {
        this.reactions.push({ messageId, emoji });
        this.#print(`${this.#selfName} reacted ${emoji} to ${messageId}`);
    }
}

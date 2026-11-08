import type { Clock } from "../lib/clock.ts";
import type { Adapter, ChannelRef, ChatMessage, SendOptions } from "./types.ts";

const SELF_ID = "gabriel";

/** A simulated group chat, driven by the simulator and by tests. */
export class CliAdapter implements Adapter {
    readonly platform = "cli" as const;
    readonly sent: { channelId: string; text: string; messageId: string; replyToMessageId?: string }[] = [];
    readonly #clock: Clock;
    readonly #selfName: string;
    readonly #mentions: readonly string[];
    readonly #print: (line: string) => void;
    #onMessage: ((message: ChatMessage) => void) | undefined;
    #nextId = 1;

    constructor(options: { clock: Clock; selfName: string; aliases?: readonly string[]; print?: (line: string) => void }) {
        this.#clock = options.clock;
        this.#selfName = options.selfName;
        this.#mentions = [options.selfName, ...(options.aliases ?? [])].map((name) => `@${name.toLowerCase()}`);
        this.#print = options.print ?? (() => {});
    }

    async start(onMessage: (message: ChatMessage) => void): Promise<void> {
        this.#onMessage = onMessage;
    }

    async stop(): Promise<void> {
        this.#onMessage = undefined;
    }

    /** Someone in the simulated group says something. Returns the new message's ID. */
    say(speaker: string, text: string, channelId = "group"): string {
        const messageId = `m${this.#nextId++}`;
        const lowered = text.toLowerCase();
        const mentionsSelf = this.#mentions.some((mention) => lowered.includes(mention));
        this.#onMessage?.({
            platform: this.platform,
            channelId,
            messageId,
            sender: { id: speaker, displayName: speaker, isBot: false },
            text,
            sentAt: this.#clock.now(),
            mentionsSelf,
            repliesToSelf: false,
            isSelf: false,
            isBacklog: false,
        });
        return messageId;
    }

    async send(channel: ChannelRef, text: string, options: SendOptions = {}): Promise<{ messageId: string }> {
        const messageId = `m${this.#nextId++}`;
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
}

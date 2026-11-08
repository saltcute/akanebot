export type Platform = "discord" | "qq" | "cli";

export type ChannelRef = {
    platform: Platform;
    channelId: string;
};

export type Sender = {
    id: string;
    displayName: string;
    isBot: boolean;
};

export type MessageReaction = { emoji: string; by: string; byUser: string };

export type ReactionEvent = ChannelRef & {
    messageId: string;
    emoji: string;
    reactor: Sender;
    isSelf: boolean;
    removed: boolean;
};

export type ChatMessage = ChannelRef & {
    messageId: string;
    sender: Sender;
    text: string;
    /** Pictures attached to this message. Described only if the agent actually reads it. */
    images?: readonly { url: string }[];
    /** Emoji reactions other people have put on this message. */
    reactions?: readonly MessageReaction[];
    sentAt: number;
    mentionsSelf: boolean;
    repliesToSelf: boolean;
    replyToMessageId?: string;
    /** The agent's own account sent this. */
    isSelf: boolean;
    /** Delivered as history (for example after a reconnect) rather than live. */
    isBacklog: boolean;
};

export type SendOptions = {
    replyToMessageId?: string;
    signal?: AbortSignal;
};

export interface Adapter {
    readonly platform: Platform;
    start(onMessage: (message: ChatMessage) => void, onReaction?: (event: ReactionEvent) => void): Promise<void>;
    stop(): Promise<void>;
    send(channel: ChannelRef, text: string, options?: SendOptions): Promise<{ messageId: string }>;
    sendTyping(channel: ChannelRef): Promise<void>;
    react?(channel: ChannelRef, messageId: string, emoji: string): Promise<void>;
}

export function channelKey(channel: ChannelRef): string {
    return `${channel.platform}:${channel.channelId}`;
}

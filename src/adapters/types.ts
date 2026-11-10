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

export type GroupEventKind =
    | "muted"
    | "unmuted"
    | "muted_all"
    | "unmuted_all"
    | "kicked"
    | "banned"
    | "unbanned"
    | "left"
    | "joined"
    | "admin_added"
    | "admin_removed"
    | "pinned"
    | "unpinned"
    | "poked";

/** Something the platform itself reports happening in a group, as opposed to anything someone said. */
export type GroupEvent = ChannelRef & {
    kind: GroupEventKind;
    actor?: Sender | undefined;
    target?: Sender | undefined;
    /** The target is the agent's own account. */
    targetIsSelf: boolean;
    durationMs?: number | undefined;
    /** The message that was pinned or unpinned. */
    messageId?: string | undefined;
    at: number;
};

/** The message a reply points at, as the chat app previews it above the reply. `byUser` is who wrote it, as a user key. */
export type QuotedMessage = { messageId: string; by: string; byUser: string; text: string; isSelf: boolean };

/** One message inside a forward. `by` and `byUser` are only what the forward claims, because QQ lets people forge them, and Discord doesn't say. */
export type ForwardedLine = {
    by?: string | undefined;
    byUser?: string | undefined;
    text: string;
    /** Pictures still to be looked at, each with an `[image]` waiting in `text`. They stay here rather than on the message, so they go when the forward does. */
    images?: readonly ChatImage[];
    /** A forward inside this one. `text` holds its placeholder. */
    forwarded?: readonly ForwardedLine[];
};

/** `url` is what to look at. `link` is set when posting this link again is how to share the picture, because there's no file to keep. */
export type ChatImage = { url: string; link?: string };

/** A picture the platform only worked out after delivering the message. */
export type LateImages = ChannelRef & { messageId: string; images: readonly ChatImage[] };

export type ChatMessage = ChannelRef & {
    messageId: string;
    sender: Sender;
    text: string;
    /** Pictures attached to this message. Described only if the agent actually reads it. */
    images?: readonly ChatImage[];
    /** The picture the agent looked at when it read this, so it can look again while the message is in view. Never set by an adapter. */
    seenImage?: ChatImage;
    /** Emoji reactions other people have put on this message. */
    reactions?: readonly MessageReaction[];
    sentAt: number;
    mentionsSelf: boolean;
    /** Names of the other people this message @-mentions, as they appear in the text. Never includes @everyone. */
    mentions?: readonly string[];
    repliesToSelf: boolean;
    replyToMessageId?: string;
    /** Absent on a reply if the platform couldn't say what it was replying to, or that person has been forgotten. */
    replyTo?: QuotedMessage;
    /** What a forward carried, in the order it was sent. Absent if it couldn't be opened. Never saved, and not the sender's own words. */
    forwarded?: readonly ForwardedLine[];
    /** The agent's own account sent this. */
    isSelf: boolean;
    /** Delivered as history (for example after a reconnect) rather than live. */
    isBacklog: boolean;
    /** This line is a platform event rather than something someone said. `involves` is who it's about, as user keys. */
    groupEvent?: { involves: readonly string[] };
};

/** A stretch of outgoing text, `@name` included, that should notify someone. Only `resolveMentions` makes these. */
export type OutgoingMention = { userId: string; start: number; end: number };

export type SendOptions = {
    replyToMessageId?: string;
    mention?: OutgoingMention;
    signal?: AbortSignal;
};

/** A picture to post, already on disk. Only ever bytes, so nothing a model wrote can make the bot fetch or link anything. */
export type OutgoingImage = { bytes: Uint8Array; mime: string };

export interface Adapter {
    readonly platform: Platform;
    start(
        onMessage: (message: ChatMessage) => void,
        onReaction?: (event: ReactionEvent) => void,
        onGroupEvent?: (event: GroupEvent) => void,
        onLateImages?: (event: LateImages) => void,
    ): Promise<void>;
    stop(): Promise<void>;
    send(channel: ChannelRef, text: string, options?: SendOptions): Promise<{ messageId: string }>;
    sendImage?(channel: ChannelRef, image: OutgoingImage, options?: SendOptions): Promise<{ messageId: string }>;
    sendTyping(channel: ChannelRef): Promise<void>;
    react?(channel: ChannelRef, messageId: string, emoji: string): Promise<void>;
    /** A human-readable name for a channel, if the platform has one to hand. */
    channelName?(channelId: string): string | undefined;
}

export function channelKey(channel: ChannelRef): string {
    return `${channel.platform}:${channel.channelId}`;
}

import type { ChatMessage, ForwardedLine, MessageReaction } from "../adapters/types.ts";
import type { Candidate } from "../body/actor.ts";
import type { CancelTimer, Clock } from "../lib/clock.ts";

export type PerceptionTiming = {
    /** Wait for this much silence before reacting. */
    quietMs: number;
    /** React after this long regardless, or an active chat would never fire. */
    maxWaitMs: number;
    /** How long an offer stays worth acting on. */
    candidateTtlMs: number;
    windowSize: number;
};

const NORMAL_PRIORITY = 1;
const MAX_EVENTS_IN_WINDOW = 5;
export const ADDRESSED_PRIORITY = 10;

export function withoutQuote({ replyTo: _replyTo, ...message }: ChatMessage): ChatMessage {
    return message;
}

/** Looks inside nested forwards too, because the operator's page shows those. */
export function forwardHolds(lines: readonly ForwardedLine[], isMatch: (user: string) => boolean): boolean {
    return lines.some((line) => (line.byUser !== undefined && isMatch(line.byUser)) || forwardHolds(line.forwarded ?? [], isMatch));
}

export function withoutForwarded({ forwarded: _forwarded, ...message }: ChatMessage): ChatMessage {
    return message;
}

export function isAddressed(message: ChatMessage): boolean {
    return message.mentionsSelf || message.repliesToSelf;
}

/** What one channel looks like from the outside: debounced, with a short rolling window. */
export class ChannelPerception {
    #channel: string;
    #clock: Clock;
    #timing: PerceptionTiming;
    #onReady: (candidate: Candidate) => void;
    #window: { message: ChatMessage; seq: number }[] = [];
    #seq = 0;
    #settledSeq = 0;
    #firstUnhandledAt: number | undefined;
    #addressedSinceLastOffer = false;
    #cancelTimer: CancelTimer | undefined;

    constructor(options: { channel: string; clock: Clock; timing: PerceptionTiming; onReady: (candidate: Candidate) => void }) {
        this.#channel = options.channel;
        this.#clock = options.clock;
        this.#timing = options.timing;
        this.#onReady = options.onReady;
    }

    ingest(message: ChatMessage): void {
        this.#seq++;
        this.#push(message);
        if (isAddressed(message)) this.#addressedSinceLastOffer = true;

        const now = this.#clock.now();
        this.#firstUnhandledAt ??= now;
        const untilMaxWait = this.#firstUnhandledAt + this.#timing.maxWaitMs - now;
        this.#cancelTimer?.();
        this.#cancelTimer = this.#clock.setTimer(Math.min(this.#timing.quietMs, untilMaxWait), () => this.#fire());
    }

    /** Records the agent's own sent message, without treating it as something to react to. */
    recordOwn(message: ChatMessage): void {
        this.#push(message);
    }

    /** Keeps a message as context without it ever counting as new or waking the agent. */
    recordSeen(message: ChatMessage): void {
        this.#window.push({ message, seq: 0 });
        if (this.#window.length > this.#timing.windowSize) this.#window.shift();
    }

    /** Swaps a message's text for a richer version, such as once a picture has been looked at. */
    annotate(messageId: string, text: string): void {
        for (const entry of this.#window) if (entry.message.messageId === messageId) entry.message = { ...entry.message, text };
    }

    /** For a picture the platform only worked out after delivering the message. */
    addImages(messageId: string, images: ChatMessage["images"]): void {
        for (const entry of this.#window)
            if (entry.message.messageId === messageId) entry.message = { ...entry.message, ...(images ? { images } : {}) };
    }

    purge(shouldRemove: (message: ChatMessage) => boolean): void {
        this.#window = this.#window.filter((entry) => !shouldRemove(entry.message));
    }

    /** Attaches to the message rather than adding a line, so a pile of reactions can't push real chat out of the window. */
    noteReaction(messageId: string, reaction: MessageReaction, removed: boolean): readonly MessageReaction[] | undefined {
        const entry = this.#window.find((candidate) => candidate.message.messageId === messageId);
        if (!entry) return undefined;
        const others = (entry.message.reactions ?? []).filter((item) => item.emoji !== reaction.emoji || item.byUser !== reaction.byUser);
        const reactions = removed ? others : [...others, reaction];
        entry.message = { ...entry.message, reactions };
        return reactions;
    }

    /** Context only, like {@link recordSeen}. Capped, or a wave of bans would push the actual chat out of the window. */
    noteEvent(message: ChatMessage): void {
        const events = this.#window.filter((entry) => entry.message.groupEvent);
        if (events.length >= MAX_EVENTS_IN_WINDOW) this.#window = this.#window.filter((entry) => entry !== events[0]);
        this.recordSeen(message);
    }

    purgeReactionsBy(user: string): void {
        for (const entry of this.#window) {
            if (entry.message.reactions)
                entry.message = { ...entry.message, reactions: entry.message.reactions.filter((item) => item.byUser !== user) };
        }
    }

    /** Someone forgotten can't live on in the preview above another person's reply, or in a log someone forwarded. */
    purgeQuotesBy(user: string): void {
        for (const entry of this.#window) {
            if (entry.message.replyTo?.byUser === user) entry.message = withoutQuote(entry.message);
            if (forwardHolds(entry.message.forwarded ?? [], (byUser) => byUser === user)) entry.message = withoutForwarded(entry.message);
        }
    }

    /** A deleted message can't live on in the preview above a reply to it. */
    purgeQuotesOf(messageId: string): void {
        for (const entry of this.#window) {
            if (entry.message.replyTo?.messageId === messageId) entry.message = withoutQuote(entry.message);
        }
    }

    window(): readonly ChatMessage[] {
        return this.#window.map((entry) => entry.message);
    }

    get seq(): number {
        return this.#seq;
    }

    /** Where the messages the agent hasn't dealt with yet begin, or undefined if there are none. */
    firstNewIndex(): number | undefined {
        const index = this.#window.findIndex((entry) => entry.seq > this.#settledSeq && !entry.message.isSelf);
        return index === -1 ? undefined : index;
    }

    unreadCount(): number {
        return this.#window.filter((entry) => entry.seq > this.#settledSeq && !entry.message.isSelf).length;
    }

    /** Everything up to `seq` has been answered or deliberately let go. */
    settle(seq: number): void {
        this.#settledSeq = Math.max(this.#settledSeq, seq);
    }

    /** Unread messages that arrived after a given point, for noticing the chat has moved on. */
    newSince(seq: number): ChatMessage[] {
        return this.#window.filter((entry) => entry.seq > seq && !entry.message.isSelf).map((entry) => entry.message);
    }

    /**
     * After time away nobody reads everything. Keeps the latest messages plus a few that were addressed to it,
     * like notifications. The rest were never read, so they vanish from view and can't become memories.
     */
    skim(maxNew: number, maxNotifications: number): number {
        const unread = this.#window.filter((entry) => entry.seq > this.#settledSeq && !entry.message.isSelf);
        if (unread.length <= maxNew) return 0;
        const older = unread.slice(0, -maxNew);
        const notifications = new Set(older.filter((entry) => isAddressed(entry.message)).slice(-maxNotifications));
        const dropped = new Set(older.filter((entry) => !notifications.has(entry)));
        this.#window = this.#window.filter((entry) => !dropped.has(entry));
        return dropped.size;
    }

    /** A fresh offer for anything still unread, used when the agent comes back. */
    unreadCandidate(): Candidate | undefined {
        const unread = this.#window.filter((entry) => entry.seq > this.#settledSeq && !entry.message.isSelf);
        if (unread.length === 0) return undefined;
        return {
            channel: this.#channel,
            snapshotSeq: this.#seq,
            priority: unread.some((entry) => isAddressed(entry.message)) ? ADDRESSED_PRIORITY : NORMAL_PRIORITY,
            expiresAt: this.#clock.now() + this.#timing.candidateTtlMs,
        };
    }

    #push(message: ChatMessage): void {
        this.#window.push({ message, seq: this.#seq });
        if (this.#window.length > this.#timing.windowSize) this.#window.shift();
    }

    #fire(): void {
        this.#cancelTimer = undefined;
        this.#firstUnhandledAt = undefined;
        const priority = this.#addressedSinceLastOffer ? ADDRESSED_PRIORITY : NORMAL_PRIORITY;
        this.#addressedSinceLastOffer = false;
        this.#onReady({
            channel: this.#channel,
            snapshotSeq: this.#seq,
            priority,
            expiresAt: this.#clock.now() + this.#timing.candidateTtlMs,
        });
    }
}

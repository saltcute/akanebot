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
    Platform,
    QuotedMessage,
    ReactionEvent,
} from "./adapters/types.ts";
import { channelKey } from "./adapters/types.ts";
import { type Attend, BodyActor, type BodyState, type Lease } from "./body/actor.ts";
import { type DayState, dayState } from "./body/life.ts";
import {
    correctStanding,
    currentRelationship,
    describeRelationship,
    fadedAffinity,
    type Relationship,
    updateRelationship,
} from "./body/relationships.ts";
import { Routine } from "./body/routine.ts";
import { busyPeriod, isAsleep } from "./body/schedule.ts";
import { Vitals } from "./body/vitals.ts";
import { MAX_MUTE_MINUTES, runCommand } from "./control/admin.ts";
import { NO_LINKS, type People } from "./control/people.ts";
import { ControlState, type ControlStore, userKey } from "./control/state.ts";
import { assessCompetence } from "./gate/competence.ts";
import { type GateFeatures, gateFeaturesSchema, renderGateInstructions } from "./gate/features.ts";
import { allAimedElsewhere, decideToRepeat, decideToSpeak, findFollowUp, findNamer, overruleMisaddress } from "./gate/policy.ts";
import { findRepeatChain } from "./gate/repeat.ts";
import { type DownloadResult, downloadImage, type ImageFetcher, linkedImage } from "./images/download.ts";
import { type FrameSheet, frameSheet } from "./images/frames.ts";
import { judgeImage } from "./images/keep.ts";
import {
    flattenCaption,
    type ImageLook,
    imageLookSchema,
    lookRequest,
    type Motion,
    REFUSED_LOOK,
    renderCaption,
    renderVisionInstructions,
} from "./images/look.ts";
import { canUseHere, chooseOffers, type OfferedImage, type OfferState, offerChance } from "./images/offer.ts";
import { type InlineImage, isAnimated, shrinkImage } from "./images/shrink.ts";
import { type Clock, sleep } from "./lib/clock.ts";
import type { CostMeter } from "./lib/cost.ts";
import type { Rng } from "./lib/rng.ts";
import type { DecisionTrace, TraceEvent } from "./lib/trace.ts";
import { type LinkOpener, openChance, pickLink } from "./links/open.ts";
import type { Embedder } from "./llm/embedder.ts";
import type { LlmRegistry } from "./llm/registry.ts";
import type { SearchBackend } from "./llm/search.ts";
import type { LoggedMessage, LogQuery, MemoryStats, MemoryStore, ReplyCaptureDraft, SavedImageQuery, SavedImageView } from "./memory/store.ts";
import { type MemorySettings, MemorySystem } from "./memory/system.ts";
import {
    ADDRESSED_PRIORITY,
    ChannelPerception,
    forwardedImages,
    forwardHolds,
    IMAGE_PLACEHOLDER,
    isAddressed,
    type PerceptionTiming,
    withoutForwarded,
    withoutQuote,
} from "./perception/channel.ts";
import { type Persona, reactionChoices } from "./persona/schema.ts";
import { explainAliases, explainClocks, timeThere } from "./reply/aliases.ts";
import { exceedsCodeLimit, toBursts } from "./reply/bursts.ts";
import { type GuardLimits, SendGuard } from "./reply/guards.ts";
import { mentionablePeople, resolveMentions } from "./reply/mentions.ts";
import { choosePictures, pictureLabel, type ShownPicture } from "./reply/pictures.ts";
import {
    renderGroupEvent,
    renderLookup,
    renderOwnImage,
    renderOwnReaction,
    renderPeople,
    renderReplyInstructions,
    renderReplyState,
    renderSavedImages,
    renderTranscript,
    replySchema,
    timezoneNote,
} from "./reply/prompt.ts";
import { type Pacing, readingDelay, thinkingDelay, typingDelay } from "./reply/timing.ts";

export type ControlOptions = {
    commandPrefix: string;
    /** `platform:userId` of each person allowed to run admin commands. */
    admins: readonly string[];
    /** A group with `shadow` reads and decides, but never posts anything. */
    groups: readonly (ChannelRef & { disclosed: boolean; shareMemory?: boolean; shadow?: boolean })[];
};

export type RuntimeOptions = {
    clock: Clock;
    rng: Rng;
    trace: DecisionTrace;
    llm: LlmRegistry;
    cost: CostMeter;
    persona: Persona;
    adapters: readonly Adapter[];
    timing: PerceptionTiming;
    limits: GuardLimits;
    control: ControlOptions;
    controlStore: ControlStore;
    memoryStore: MemoryStore;
    embedder: Embedder;
    memorySettings: MemorySettings;
    /** Human reading and typing delays. Without it, replies go out as soon as they're written. */
    pacing?: Pacing;
    /** Follow the persona's sleep and busy hours. */
    routine?: boolean;
    search?: SearchBackend;
    /** Which accounts are the same person. */
    people?: People;
    /** The most pictures from the chat shown to the reply model at once. Without it she only reads their descriptions. */
    picturesPerReply?: number;
    /** Shrink those pictures to this many pixels on the long edge. Needs `fetchImage`. Without it they're sent as links, at full size. */
    pictureMaxEdge?: number;
    /** Without it she can't download pictures, so she only collects ones that are just links. */
    fetchImage?: ImageFetcher;
    /** Without it she never opens links, whatever the persona says. */
    links?: LinkOpener;
    /** Keeps each reply request and answer in the memory database, for trying other models on later. */
    captureReplies?: boolean;
};

/** One message inside a forward, as the operator sees it. The name is only what the forward claims. */
export type ForwardedView = { by: string | undefined; text: string; forwarded: ForwardedView[] | undefined };

/** One line of a conversation, as the operator sees it. */
export type ConversationMessage = {
    messageId: string;
    senderName: string;
    senderKey: string;
    isSelf: boolean;
    /** A platform event such as a mute, rather than something someone said. */
    isEvent: boolean;
    /** Something it would have posted, held back by shadow mode. Nobody in the chat saw it. */
    isShadow: boolean;
    addressed: boolean;
    text: string;
    sentAt: number;
    reactions: readonly { emoji: string; by: string }[];
    isReply: boolean;
    /** What it replies to, when that's known. */
    quoted: { senderName: string; text: string } | undefined;
    /** What it forwarded, for as long as it stays in the live window. */
    forwarded: ForwardedView[] | undefined;
};

export type ConversationSummary = {
    key: string;
    name: string | undefined;
    mutedUntil: number | undefined;
    /** She decides here, but nothing gets posted. */
    shadow: boolean;
    attending: boolean;
    /** Messages it hasn't answered or let go of yet. */
    unread: number;
    /** Messages it has read that aren't memories yet. */
    undigested: number;
    lastMessage: ConversationMessage | undefined;
};

export type ConversationDetail = ConversationSummary & {
    messages: ConversationMessage[];
    /** Where the unread messages begin, or undefined if there are none. */
    firstNewIndex: number | undefined;
};

/** One person as the operator sees them, across all their accounts. */
export type PersonSummary = {
    /** Works anywhere the API takes a person. */
    key: string;
    name: string;
    accounts: readonly string[];
    note: string | undefined;
    aliases: readonly string[];
    /** What each group calls them, most recently used first. */
    groupNames: { name: string; groups: string[] }[];
    timezone: string | undefined;
    messages: number;
    lastSeen: number | undefined;
    optedOut: boolean;
    /** Undefined when she has no feelings about them yet. */
    standing: Relationship | undefined;
    groups: { channel: string; name: string; familiarity: number; affinity: number; updatedAt: number }[];
};

export type RuntimeStatus = {
    personaName: string;
    /** How many of the allowed channels are in shadow mode, out of `channels`. */
    shadowChannels: number;
    channels: number;
    killed: boolean;
    body: BodyState;
    attending: string | undefined;
    awayReasons: readonly string[];
    /** Undefined unless she is busy and away with a glance at her phone coming up. */
    nextPhoneCheckInMs: number | undefined;
    battery: number;
    searchesToday: number;
    cost: ReturnType<CostMeter["summary"]>;
};

/** Everything about how she is right now, for the operator. */
export type BodySnapshot = {
    state: BodyState;
    attending: { channel: string; name: string } | undefined;
    awayReasons: readonly string[];
    activity: "asleep" | "busy" | "free";
    /** Undefined when this run doesn't follow the schedule. */
    present: boolean | undefined;
    /** Undefined unless she is busy and away with a glance at her phone coming up. */
    nextPhoneCheckInMs: number | undefined;
    day: DayState;
    battery: number;
    searchesToday: number;
    searchCap: number;
    linksToday: number;
    linkCap: number;
    guard: ReturnType<SendGuard["snapshot"]> & { channels: { channel: string; name: string; share: number; sample: number }[] };
    cost: ReturnType<CostMeter["summary"]>;
    memory: MemoryStats;
    lastNight: { date: string | undefined; finishedAt: number | undefined; report: Record<string, unknown> | undefined };
};

const KILL_REASON = "kill";
const DEFAULT_SHEET_EDGE = 1024;
const ROUTINE_REASON = "routine";

/** `names` is what each person here was last called, by user key. */
type Channel = { ref: ChannelRef; adapter: Adapter; perception: ChannelPerception; names: Map<string, string> };
/** `frames` is set for an animation whose file could be read, and is what any model is shown of it in place of the picture. */
type FetchedImage = { animated: boolean; inline?: InlineImage; frames?: FrameSheet };
type LookedAt = { message: ChatMessage; image: ChatImage; look: ImageLook };

function motionOf({ animated, frames }: FetchedImage): Motion {
    if (frames) return "frames";
    return animated ? "firstFrame" : "still";
}

/** Why someone who asked for a picture isn't getting one: she doesn't feel like it, or has none she could post here. */
type Declined = "unwilling" | "nothing";
type ImageOffer = { offered: OfferedImage[]; declined?: Declined };
const NO_OFFER: ImageOffer = { offered: [] };

const GATE_MAX_OUTPUT = 600;
const REPLY_MAX_OUTPUT = 2000;
const TECHNICAL_MAX_OUTPUT = 4000;
const MAX_NEW_MESSAGES_READ = 15;
const MAX_NOTIFICATIONS = 2;
const ABANDON_AFTER_NEW_MESSAGES = 6;
const QUOTE_AFTER_NEW_MESSAGES = 3;
const ADDRESSED_BATTERY_COST = 0.5;
const LOW_BATTERY = 0.3;
const TYPING_REFRESH_MS = 8000;
const LATE_REPLY_MS = 30 * 60_000;
const REACTION_BATTERY_COST = 0.25;
const REACTION_PAUSE_MS = 800;
const GROUP_EVENT_SENDER = "(group event)";
const LEFT_ON_READ_REACTION = 0.5;
const MAX_IMAGES_PER_ATTEND = 2;
const VISION_MAX_OUTPUT = 400;
const MAX_CAPTION_CHARS = 200;
const MAX_USE_FOR_CHARS = 40;
const MAX_IMAGES_KEPT_PER_PERSON_PER_DAY = 5;
const DAY_MS = 86_400_000;
/** Posting pictures back to back gets old fast, and so does the same picture twice in a week. */
const IMAGE_COOLDOWN_MS = 15 * 60_000;
const IMAGE_REUSE_AFTER_MS = 3 * DAY_MS;
/** A link she's opened, or decided not to, isn't considered again for this long, wherever it's posted. */
const LINK_MEMORY_MS = 6 * 3_600_000;
/** Covers the vendor's fetch, the slowest way to read a page. */
const LINK_TIMEOUT_MS = 30_000;
/** No one person gets more than this share of the day's links, so one person posting a lot can't use them all. */
const LINK_SHARE_PER_PERSON = 0.4;

/** Wires adapters to perception, the body, the gate and the send guards. */
export class Runtime {
    readonly body: BodyActor;
    readonly guard: SendGuard;
    readonly memory: MemorySystem;
    readonly vitals: Vitals;
    #routine: Routine | undefined;
    #pacingRng: Rng;
    #reactionRng: Rng;
    #searchRng: Rng;
    #imageRng: Rng;
    #linkRng: Rng;
    #consideredLinks = new Map<string, number>();
    #fetchedImages = new WeakMap<ChatImage, Promise<FetchedImage>>();
    #lastImageSentAt = new Map<string, number>();
    #sharing: ReadonlySet<string>;
    #options: RuntimeOptions;
    #adapters: ReadonlyMap<Platform, Adapter>;
    #channels = new Map<string, Channel>();
    #gateRng: Rng;
    #competenceRng: Rng;
    #persona: Persona;
    #state: ControlState;
    #people: People;
    #allowedChannels: ReadonlySet<string>;
    #shadowChannels: ReadonlySet<string>;
    #background = new Set<Promise<void>>();
    #nextEventId = 1;

    constructor(options: RuntimeOptions) {
        this.#options = options;
        this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
        this.#gateRng = options.rng.fork("gate");
        this.#competenceRng = options.rng.fork("competence");
        this.#shadowChannels = new Set(options.control.groups.filter((group) => group.disclosed && group.shadow === true).map(channelKey));
        this.guard = new SendGuard({ clock: options.clock, trace: options.trace, limits: options.limits, shadowChannels: this.#shadowChannels });
        const attend: Attend = (lease) => this.#attend(lease);
        this.body = new BodyActor({ clock: options.clock, trace: options.trace, attend });
        this.#persona = options.persona;
        this.#people = options.people ?? NO_LINKS;
        this.#state = new ControlState({ clock: options.clock, store: options.controlStore, people: this.#people });
        this.#allowedChannels = new Set(options.control.groups.filter((group) => group.disclosed).map(channelKey));
        const sharing = new Set(options.control.groups.filter((group) => group.disclosed && group.shareMemory !== false).map(channelKey));
        this.#sharing = sharing;
        if (this.#state.killed) this.body.goAway(KILL_REASON);
        this.#pacingRng = options.rng.fork("pacing");
        this.#reactionRng = options.rng.fork("reaction");
        this.#searchRng = options.rng.fork("search");
        this.#imageRng = options.rng.fork("images");
        this.#linkRng = options.rng.fork("links");
        this.vitals = new Vitals({ clock: options.clock, persona: () => this.#persona, store: options.memoryStore });
        if (options.routine) {
            this.#routine = new Routine({
                clock: options.clock,
                rng: options.rng.fork("routine"),
                trace: options.trace,
                persona: () => this.#persona,
                leave: () => this.body.goAway(ROUTINE_REASON),
                arrive: () => {
                    this.body.comeBack(ROUTINE_REASON);
                    this.#offerUnread();
                },
            });
        }
        this.memory = new MemorySystem({
            store: options.memoryStore,
            embedder: options.embedder,
            llm: options.llm,
            clock: options.clock,
            rng: options.rng.fork("recall"),
            trace: options.trace,
            persona: () => this.#persona,
            settings: options.memorySettings,
            alert: (reason, detail) => this.#alert(reason, detail),
            people: this.#people,
            sharesMemory: (channel) => sharing.has(channel),
        });
    }

    get persona(): Persona {
        return this.#persona;
    }

    setPersona(persona: Persona): void {
        this.#persona = persona;
    }

    /** Resolves once the body is idle and no safety work is still running. */
    async whenIdle(): Promise<void> {
        do {
            await Promise.all(this.#background);
            await this.body.whenIdle();
            await this.memory.whenIdle();
        } while (this.#background.size > 0);
    }

    async start(): Promise<void> {
        await Promise.all(
            this.#options.adapters.map((adapter) =>
                adapter.start(
                    (message) => this.#onMessage(message),
                    (event) => this.#onReaction(event),
                    (event) => this.#onGroupEvent(event),
                    (event) => this.#onLateImages(event),
                    (event) => this.#onRemoved(event),
                    (event) => this.#onRevised(event),
                ),
            ),
        );
        this.memory.start();
        this.#routine?.start();
    }

    async stop(): Promise<void> {
        this.memory.stop();
        this.#routine?.stop();
        await Promise.all(this.#options.adapters.map((adapter) => adapter.stop()));
    }

    #onMessage(message: ChatMessage): void {
        const { trace, control } = this.#options;
        const key = channelKey(message);
        if (!this.#allowedChannels.has(key)) {
            trace.record("control.not_allowed", { channel: key, messageId: message.messageId });
            return;
        }
        const observation = this.guard.observe(message);
        trace.record("message.observed", { channel: key, messageId: message.messageId, detail: { observation } });
        if (observation !== "new") return;

        const channel = this.#channel(message);
        const command = runCommand(message, { prefix: control.commandPrefix, admins: control.admins, state: this.#state });
        if (command.handled) {
            trace.record("control.command", { channel: key, messageId: message.messageId });
            if (command.bodyEffect === "stop") this.body.goAway(KILL_REASON);
            if (command.bodyEffect === "resume") this.body.comeBack(KILL_REASON);
            if (command.forgetUser) this.#forgetUser(command.forgetUser);
            if (command.ack) this.#inBackground(this.#acknowledge(channel, command.ack, command.urgent));
            return;
        }
        if (this.#state.killed) return;
        const user = userKey(message);
        if (this.#state.isOptedOut(user)) {
            trace.record("control.opted_out", { channel: key, messageId: message.messageId });
            return;
        }

        this.#noticeRename(channel, message);
        this.#admit(channel, this.#withoutOptedOut(message));
    }

    /** No chat app announces a new name. She notices the way anyone does, when someone she knows next speaks under one. */
    #noticeRename(channel: Channel, message: ChatMessage): void {
        const { sender, isSelf } = message;
        // Bots that speak for other people change their name with every message.
        if (isSelf || sender.isBot) return;
        const user = userKey(message);
        const known = channel.names.get(user);
        channel.names.set(user, sender.displayName);
        if (known === undefined || known === sender.displayName) return;
        this.#onGroupEvent({ ...channel.ref, kind: "renamed", target: sender, targetIsSelf: false, detail: known, at: message.sentAt });
    }

    /** The chat app would show them the quote or the forward, but an opt-out means she doesn't get to read this person at all. */
    #withoutOptedOut(message: ChatMessage): ChatMessage {
        const unquoted = message.replyTo && this.#state.isOptedOut(message.replyTo.byUser) ? withoutQuote(message) : message;
        return forwardHolds(unquoted.forwarded ?? [], (user) => this.#state.isOptedOut(user)) ? withoutForwarded(unquoted) : unquoted;
    }

    /** Coming back works like checking a phone: everything unread gets a look, most important first. */
    #offerUnread(): void {
        for (const channel of this.#channels.values()) {
            const candidate = channel.perception.unreadCandidate();
            if (candidate) this.body.offer(candidate);
        }
    }

    #forgetUser(user: string): number {
        const removed = this.memory.forgetUser(user);
        for (const account of this.#people.accountsOf(user)) {
            for (const channel of this.#channels.values()) {
                channel.perception.purge((message) => userKey(message) === account || Boolean(message.groupEvent?.involves.includes(account)));
                channel.perception.purgeReactionsBy(account);
                channel.perception.purgeQuotesBy(account);
                channel.names.delete(account);
            }
        }
        this.vitals.forgetLinksFrom(this.#people.personOf(user));
        return removed;
    }

    status(): RuntimeStatus {
        return {
            personaName: this.#persona.name,
            shadowChannels: this.#shadowChannels.size,
            channels: this.#allowedChannels.size,
            killed: this.#state.killed,
            body: this.body.state,
            attending: this.body.attending,
            awayReasons: this.body.awayReasons,
            nextPhoneCheckInMs: this.#routine?.nextPhoneCheckInMs,
            battery: this.vitals.battery(),
            searchesToday: this.vitals.searchesToday(),
            cost: this.#options.cost.summary(),
        };
    }

    bodySnapshot(): BodySnapshot {
        const now = this.#options.clock.now();
        const persona = this.#persona;
        const attending = this.body.attending;
        const guard = this.guard.snapshot();
        const lastRun = this.#options.trace.ofKind("memory.consolidated").at(-1);
        return {
            state: this.body.state,
            attending: attending ? { channel: attending, name: this.channelName(attending) ?? attending } : undefined,
            awayReasons: this.body.awayReasons,
            activity: isAsleep(persona, now) ? "asleep" : busyPeriod(persona, now) ? "busy" : "free",
            present: this.#routine?.present,
            nextPhoneCheckInMs: this.#routine?.nextPhoneCheckInMs,
            day: dayState(persona, now),
            battery: this.vitals.battery(),
            searchesToday: this.vitals.searchesToday(),
            searchCap: persona.search.dailyCap,
            linksToday: this.vitals.linksToday(),
            linkCap: persona.links.dailyCap,
            guard: {
                ...guard,
                channels: guard.channels.map((channel) => ({ ...channel, name: this.channelName(channel.channel) ?? channel.channel })),
            },
            cost: this.#options.cost.summary(),
            memory: this.memory.store.stats(),
            lastNight: { date: this.memory.lastConsolidationDate, finishedAt: lastRun?.at, report: lastRun?.detail },
        };
    }

    recentAlerts(limit: number): TraceEvent[] {
        return this.#options.trace.ofKind("alert").slice(-limit);
    }

    /** The most recent decisions since this process started, newest first. The caller chooses how much of each to show. */
    recentTrace(query: { kind?: string | undefined; channel?: string | undefined; limit: number }): TraceEvent[] {
        return this.#options.trace
            .all()
            .filter((event) => (!query.kind || event.kind === query.kind) && (!query.channel || event.channel === query.channel))
            .slice(-query.limit)
            .reverse();
    }

    traceKinds(): string[] {
        return [...new Set(this.#options.trace.all().map((event) => event.kind))].sort();
    }

    /** Decisions recorded about a message since this process started. */
    decisionsAbout(messageId: string): TraceEvent[] {
        return this.#options.trace.forMessage(messageId);
    }

    hasConversation(key: string): boolean {
        return this.#allowedChannels.has(key);
    }

    /** Every allowed channel, including ones nobody has spoken in since startup, most recently active first. */
    conversations(): ConversationSummary[] {
        return [...this.#allowedChannels]
            .map((key) => this.#summarize(key, this.#visibleMessages(key)))
            .sort((a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0));
    }

    conversation(key: string): ConversationDetail | undefined {
        if (!this.hasConversation(key)) return undefined;
        const window = this.#visibleMessages(key);
        const messages = withShadowSends(window.map(toConversationMessage), this.#shadowSends(key, window));
        const firstNew = this.#channels.get(key)?.perception.firstNewIndex();
        return {
            ...this.#summarize(key, window),
            messages,
            firstNewIndex: firstNew === undefined ? undefined : messages.findIndex((message) => message.messageId === window[firstNew]?.messageId),
        };
    }

    /** Everyone she has any data on, or the operator has declared, most recently seen first. */
    roster(): PersonSummary[] {
        const { store } = this.memory;
        const now = this.#options.clock.now();
        const speakers = new Map(store.loggedSpeakers().map((speaker) => [speaker.userKey, speaker]));
        const relationships = store.allRelationships();
        const groupNames = store.groupNames();
        const accounts = [
            ...this.#people.entries().flatMap((entry) => entry.ids),
            ...speakers.keys(),
            ...relationships.map((row) => row.userKey),
            ...this.#state.optedOut(),
        ];
        return [...new Set(accounts.map((account) => this.#people.personOf(account)))]
            .map((key): PersonSummary => {
                const linked = this.#people.accountsOf(key);
                const seen = linked.flatMap((account) => speakers.get(account) ?? []).sort((a, b) => b.lastSeen - a.lastSeen);
                const rows = relationships.filter((row) => linked.includes(row.userKey));
                return {
                    key,
                    // A name from one group would be wrong in every other, so the account's own name comes first.
                    name: this.#people.nameOf(key) ?? seen.find((speaker) => speaker.accountName)?.accountName ?? seen[0]?.displayName ?? key,
                    accounts: linked,
                    note: this.#people.noteOf(key),
                    aliases: this.#people.aliasesOf(key),
                    groupNames: [
                        ...Map.groupBy(
                            groupNames.filter((row) => linked.includes(row.userKey)),
                            (row) => row.displayName,
                        ),
                    ].map(([name, rows]) => ({ name, groups: rows.map((row) => this.channelName(row.channel) ?? row.channel) })),
                    timezone: this.#people.timezoneOf(key),
                    messages: seen.reduce((total, speaker) => total + speaker.messages, 0),
                    lastSeen: seen[0]?.lastSeen,
                    optedOut: this.#state.isOptedOut(key),
                    standing: rows.length > 0 ? currentRelationship(store, key, now, this.#people) : undefined,
                    groups: rows.map((row) => ({
                        channel: row.channel,
                        name: this.channelName(row.channel) ?? row.channel,
                        familiarity: row.familiarity,
                        affinity: fadedAffinity(row, now),
                        updatedAt: row.updatedAt,
                    })),
                };
            })
            .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name));
    }

    /** The raw log for the operator, one page at a time. A person's filter covers all their accounts. */
    history(query: Omit<LogQuery, "users"> & { user?: string | undefined }): {
        messages: (LoggedMessage & { channelName: string })[];
        total: number;
        channels: { key: string; name: string }[];
    } {
        const { user, ...rest } = query;
        const { store } = this.memory;
        const { messages, total } = store.browseLog({ ...rest, ...(user ? { users: this.#people.accountsOf(user) } : {}) });
        return {
            messages: messages.map((message) => ({ ...message, channelName: this.channelName(message.channel) ?? message.channel })),
            total,
            channels: store.logChannels().map((key) => ({ key, name: this.channelName(key) ?? key })),
        };
    }

    /** Her saved pictures for the operator, one page at a time. A person's filter covers all their accounts. */
    savedImagesPage(query: Omit<SavedImageQuery, "users"> & { user?: string | undefined }): {
        images: (SavedImageView & { scopeName: string; posterName: string })[];
        total: number;
        scopes: { key: string; name: string }[];
    } {
        const { user, ...rest } = query;
        const { store } = this.memory;
        const { images, total } = store.browseSavedImages({ ...rest, ...(user ? { users: this.#people.accountsOf(user) } : {}) });
        return {
            images: images.map((image) => ({
                ...image,
                scopeName: this.channelName(image.scope) ?? image.scope,
                posterName: this.#people.nameOf(image.userKey) ?? store.stableNameOf(image.userKey) ?? image.userKey,
            })),
            total,
            scopes: store.savedImageScopes().map((key) => ({ key, name: this.channelName(key) ?? key })),
        };
    }

    /** What's written here reaches her prompts, so it's flattened the same way a model's description is. */
    async editSavedImage(id: number, fields: { description: string; useFor: string }): Promise<void> {
        const { embedder, trace } = this.#options;
        const description = flattenCaption(fields.description, MAX_CAPTION_CHARS);
        const useFor = flattenCaption(fields.useFor, MAX_USE_FOR_CHARS);
        const embedding = await embedder.embed(`${useFor} ${description}`, "passage");
        this.memory.store.editSavedImage(id, { description, useFor, embedding, embeddingModel: embedding ? embedder.modelId : null });
        trace.record("control.web", { detail: { action: "edit_image", image: id } });
    }

    deleteSavedImage(id: number): void {
        this.memory.store.deleteSavedImage(id);
        this.#options.trace.record("control.web", { detail: { action: "delete_image", image: id } });
    }

    channelName(key: string): string | undefined {
        const separator = key.indexOf(":");
        return this.#adapters.get(key.slice(0, separator) as Platform)?.channelName?.(key.slice(separator + 1));
    }

    muteConversation(key: string, minutes: number): void {
        const clamped = Math.min(minutes, MAX_MUTE_MINUTES);
        this.#state.mute(key, clamped * 60_000);
        this.#options.trace.record("control.web", { channel: key, detail: { action: "mute", minutes: clamped } });
    }

    unmuteConversation(key: string): void {
        this.#state.unmute(key);
        this.#options.trace.record("control.web", { channel: key, detail: { action: "unmute" } });
    }

    /** She lets go of whatever is unread. Those messages stay visible but won't be answered or remembered. */
    markConversationRead(key: string): void {
        const channel = this.#channels.get(key);
        channel?.perception.settle(channel.perception.seq);
        this.#options.trace.record("control.web", { channel: key, detail: { action: "mark_read" } });
    }

    /** Turns what she has read so far into memories now. Returns how many messages are still undigested. */
    async digestConversation(key: string): Promise<number> {
        this.#options.trace.record("control.web", { channel: key, detail: { action: "digest" } });
        await this.memory.closeSegment(key);
        return this.memory.store.openSegment(key).length;
    }

    kill(): void {
        this.#state.setKilled(true);
        this.body.goAway(KILL_REASON);
        this.#options.trace.record("control.web", { detail: { action: "kill" } });
    }

    resume(): void {
        this.#state.setKilled(false);
        this.body.comeBack(KILL_REASON);
        this.#options.trace.record("control.web", { detail: { action: "resume" } });
    }

    /** Leaves a record of what an operator changed. IDs only, so a deleted memory's text doesn't live on in the trace. */
    noteOperatorAction(action: string, detail: Record<string, unknown>): void {
        this.#options.trace.record("control.web", { detail: { action, ...detail } });
    }

    /** Also clears the live windows. Returns how many memories went. */
    forgetPerson(user: string): number {
        this.#options.trace.record("control.web", { detail: { action: "forget_person", user } });
        return this.#forgetUser(user);
    }

    /** Removes it from the log and from what she can see. False if it wasn't logged. */
    deleteMessage(channel: string, messageId: string): boolean {
        if (!this.memory.store.deleteLogged(channel, messageId)) return false;
        this.#unsee(channel, messageId);
        this.#options.trace.record("control.web", { channel, messageId, detail: { action: "delete_message" } });
        return true;
    }

    /** Also drops what shows part of it: the preview above a reply, and the line saying it was pinned. */
    #unsee(channel: string, messageId: string): void {
        const perception = this.#channels.get(channel)?.perception;
        perception?.purge((message) => message.messageId === messageId || message.groupEvent?.quotes === messageId);
        perception?.purgeQuotesOf(messageId);
    }

    setBattery(level: number): void {
        this.vitals.setBattery(level);
        this.#options.trace.record("control.web", { detail: { action: "set_battery", level } });
    }

    /** What the chat command does: she stops reading them and everything derived from them goes. Returns how many memories went. */
    optOutPerson(user: string): number {
        this.#state.optOut(user);
        this.#options.trace.record("control.web", { detail: { action: "opt_out", user } });
        return this.#forgetUser(user);
    }

    /** She can read them again. Whatever went when they opted out doesn't come back. */
    optInPerson(user: string): void {
        this.#state.optIn(user);
        this.#options.trace.record("control.web", { detail: { action: "opt_in", user } });
    }

    /** False when she has no feelings about this person to correct. */
    correctStanding(user: string, correction: Partial<Relationship>): boolean {
        const corrected = correctStanding(this.memory.store, user, correction, this.#options.clock.now(), this.#people);
        if (corrected) this.#options.trace.record("control.web", { detail: { action: "correct_relationship", user, ...correction } });
        return corrected;
    }

    /** Back to strangers, on every account. Her memories of them stay. */
    resetStanding(user: string): void {
        this.memory.store.deleteRelationships(this.#people.accountsOf(user));
        this.#options.trace.record("control.web", { detail: { action: "reset_relationship", user } });
    }

    /** The live window, or what a restart would restore if nobody has spoken here yet. */
    #visibleMessages(key: string): readonly ChatMessage[] {
        return this.#channels.get(key)?.perception.window() ?? this.memory.restoreWindow(key, this.#options.timing.windowSize);
    }

    /** For the operator only. These stay out of the window, so the agent never sees words it didn't send. */
    #shadowSends(key: string, window: readonly ChatMessage[]): ConversationMessage[] {
        const channel = this.#channels.get(key);
        if (!channel) return [];
        const since = window[0]?.sentAt ?? Infinity;
        return this.#options.trace.ofKind("send.shadow").flatMap((event, index) => {
            if (event.channel !== key || event.at < since) return [];
            const target = window.find((message) => message.messageId === event.detail?.replyToMessageId);
            const own = ownMessage(
                channel.ref,
                `shadow:${index}`,
                String(event.detail?.text ?? ""),
                event.at,
                this.#persona.name,
                target && quoteOf(target),
            );
            return [{ ...toConversationMessage(own), isShadow: true }];
        });
    }

    #summarize(key: string, window: readonly ChatMessage[]): ConversationSummary {
        const last = window.at(-1);
        return {
            key,
            name: this.channelName(key),
            mutedUntil: this.#state.mutedUntil(key),
            shadow: this.#shadowChannels.has(key),
            attending: this.body.attending === key,
            unread: this.#channels.get(key)?.perception.unreadCount() ?? 0,
            undigested: this.memory.store.openSegment(key).length,
            lastMessage: last ? toConversationMessage(last) : undefined,
        };
    }

    #admit(channel: Channel, message: ChatMessage): void {
        this.memory.recordIncoming(message);
        if (this.#state.isMuted(channelKey(channel.ref))) channel.perception.recordSeen(message);
        else {
            channel.perception.ingest(message);
            if (isAddressed(message)) this.#routine?.noteMention();
        }
    }

    #inBackground(work: Promise<void>): void {
        const tracked: Promise<void> = work
            .catch((error) => this.#alert("background_failed", { error: String(error) }))
            .finally(() => this.#background.delete(tracked));
        this.#background.add(tracked);
    }

    #alert(reason: string, detail: Record<string, unknown>): void {
        this.#options.trace.record("alert", { detail: { reason, ...detail } });
    }

    async #acknowledge(channel: Channel, text: string, urgent: boolean): Promise<void> {
        // Not recorded in the window: confirmations belong to the operator's voice, not the persona's.
        if (urgent) await this.guard.sendUrgent(channel.adapter, channel.ref, text);
        else await this.guard.send(channel.adapter, channel.ref, text);
    }

    /** Reactions are context for the next time it reads the chat. They never wake it up. */
    #onReaction(event: ReactionEvent): void {
        const key = channelKey(event);
        if (event.isSelf || this.#state.killed || !this.#allowedChannels.has(key)) return;
        const user = `${event.platform}:${event.reactor.id}`;
        if (this.#state.isOptedOut(user)) return;
        const reaction = { emoji: event.emoji, by: event.reactor.displayName, byUser: user };
        const reactions = this.#channel(event).perception.noteReaction(event.messageId, reaction, event.removed);
        if (reactions) this.memory.store.setReactions(key, event.messageId, reactions);
        this.#options.trace.record("reaction.seen", {
            channel: key,
            messageId: event.messageId,
            detail: { emoji: event.emoji, noted: reactions !== undefined, removed: event.removed },
        });
    }

    /** Only ever fills in a message she can already see, so anyone opted out stays out. */
    #onLateImages(event: LateImages): void {
        this.#channels.get(channelKey(event))?.perception.addImages(event.messageId, event.images);
    }

    /**
     * Someone took a message back, so it leaves the log and what she can see, whoever wrote it and whether or not she's awake.
     * A memory she already formed from it stays, as it would for anyone who read it first.
     */
    #onRemoved(event: MessageRemoval): void {
        const key = channelKey(event);
        if (!this.#allowedChannels.has(key)) return;
        for (const messageId of event.messageIds) {
            const logged = this.memory.store.deleteLogged(key, messageId);
            this.#unsee(key, messageId);
            this.#options.trace.record("message.removed", { channel: key, messageId, detail: { logged } });
        }
    }

    /** Only rewrites a message she can already see, so it never wakes her and anyone opted out stays out. */
    #onRevised({ message, edited }: MessageRevision): void {
        const key = channelKey(message);
        const perception = this.#channels.get(key)?.perception;
        const current = perception?.window().find((candidate) => candidate.messageId === message.messageId);
        if (!perception || !current || current.isSelf || current.groupEvent || current.text === message.text) return;
        // What she saw in a picture is written into the text, and the new version would lose it.
        if (current.images?.length || message.text.includes(IMAGE_PLACEHOLDER)) return;
        // A link she opened stays opened while it's still there. An edit that takes it out takes what she read with it.
        const { readLink } = current;
        const at = readLink ? message.text.indexOf(readLink.url) : -1;
        const text =
            readLink && at >= 0 ? `${message.text.slice(0, at)}${readLink.caption}${message.text.slice(at + readLink.url.length)}` : message.text;
        if (text === current.text) return;
        perception.revise(message.messageId, text, message.mentions, edited);
        if (readLink && at >= 0) perception.noteLink(message.messageId, text, readLink);
        this.memory.store.updateText(key, message.messageId, text);
        this.#options.trace.record("message.revised", { channel: key, messageId: message.messageId, detail: { edited } });
    }

    /** Also only context, kept to the live window: it never wakes the agent or becomes a memory. */
    #onGroupEvent(event: GroupEvent): void {
        const key = channelKey(event);
        if (this.#state.killed || !this.#allowedChannels.has(key)) return;
        const people = [event.actor, event.target].flatMap((person) => (person ? [`${event.platform}:${person.id}`] : []));
        if (people.some((user) => this.#state.isOptedOut(user))) return;
        const { perception } = this.#channel(event);
        const pinned = perception.window().find((message) => message.messageId === event.messageId && !message.groupEvent);
        const messageId = `event:${this.#nextEventId++}`;
        perception.noteEvent({
            platform: event.platform,
            channelId: event.channelId,
            messageId,
            sender: { id: "event", displayName: GROUP_EVENT_SENDER, isBot: false },
            text: renderGroupEvent(event, pinned),
            sentAt: event.at,
            mentionsSelf: false,
            repliesToSelf: false,
            isSelf: false,
            isBacklog: false,
            groupEvent: { involves: [...people, ...(pinned ? [userKey(pinned)] : [])], ...(pinned ? { quotes: pinned.messageId } : {}) },
        });
        this.#options.trace.record("group_event.seen", { channel: key, messageId, detail: { kind: event.kind } });
    }

    #channel(ref: ChannelRef): Channel {
        const key = channelKey(ref);
        const existing = this.#channels.get(key);
        if (existing) return existing;
        const adapter = this.#adapters.get(ref.platform);
        if (!adapter) throw new Error(`No adapter for platform "${ref.platform}"`);
        const perception = new ChannelPerception({
            channel: key,
            clock: this.#options.clock,
            timing: this.#options.timing,
            onReady: (candidate) => this.body.offer(candidate),
        });
        const channel: Channel = { ref: { platform: ref.platform, channelId: ref.channelId }, adapter, perception, names: new Map() };
        for (const message of this.memory.restoreWindow(key, this.#options.timing.windowSize)) {
            perception.recordSeen(message);
            if (!message.isSelf && !message.sender.isBot) channel.names.set(userKey(message), message.sender.displayName);
        }
        this.#channels.set(key, channel);
        return channel;
    }

    async #attend(lease: Lease): Promise<void> {
        const { trace, llm, cost, clock } = this.#options;
        const persona = this.#persona;
        const key = lease.candidate.channel;
        const channel = this.#channels.get(key);
        if (!channel) return;
        if (this.#state.killed || this.#state.isMuted(key)) return;
        if (cost.overBudget()) {
            trace.record("budget.exceeded", { channel: key, detail: cost.summary() });
            return;
        }

        const { pacing } = this.#options;
        const attendStart = clock.now();
        const { perception } = channel;
        const skipped = perception.skim(MAX_NEW_MESSAGES_READ, MAX_NOTIFICATIONS);
        if (skipped > 0) trace.record("body.skimmed", { channel: key, detail: { skipped } });
        if (perception.firstNewIndex() === undefined) return;
        const looked = await this.#lookAtImages(key, perception, persona, lease.signal);
        await this.#maybeOpenLink(key, perception, persona, lease.signal);
        const firstNewIndex = perception.firstNewIndex();
        if (firstNewIndex === undefined) return;
        const seenSeq = perception.seq;
        const window = perception.window();
        const messageId = window.findLast(isSpoken)?.messageId;
        const idField = messageId ? { messageId } : {};
        const transcript = renderTranscript(window, persona, firstNewIndex);
        const gate = await llm.generate("gate", {
            stable: renderGateInstructions(persona, channel.ref.platform),
            transcript,
            volatile: "",
            schema: gateFeaturesSchema,
            maxOutput: GATE_MAX_OUTPUT,
            signal: lease.signal,
        });
        if (gate.kind !== "ok" || !gate.data) {
            trace.record("gate.silent", { channel: key, ...idField, detail: describeFailure(gate) });
            if (gate.kind === "error" && !lease.signal.aborted) this.#alert("gate_failed", { channel: key, ...describeFailure(gate) });
            return;
        }

        const newMessages = window.slice(firstNewIndex).filter((message) => isSpoken(message) && !message.isSelf);
        this.memory.markAttended(key, newMessages);
        this.#considerKeeping(key, looked);
        const features: GateFeatures = overruleMisaddress(gate.data, newMessages, persona);
        const now = clock.now();
        const newest = newMessages.at(-1);
        const namer = findNamer(newMessages, persona);
        const followedUp = findFollowUp(window, firstNewIndex, persona);
        const asker = newMessages.findLast(isAddressed) ?? namer ?? followedUp ?? newest;
        const askerKey = asker ? userKey(asker) : undefined;
        const store = this.memory.store;
        const mentioned = lease.candidate.priority >= ADDRESSED_PRIORITY;
        const ignoreKey = `${key}|${askerKey}`;
        const day = dayState(persona, now);
        const battery = this.vitals.battery();
        const competence = assessCompetence(features, persona, this.#competenceRng);
        const speakContext = {
            battery,
            joinFactor: day.joinFactor,
            affinity: askerKey ? currentRelationship(store, askerKey, now, this.#people).affinity : 0,
            staleMs: newest ? now - newest.sentAt : 0,
            forceAnswer: this.vitals.wasRecentlyIgnored(ignoreKey),
            outOfDepth: competence.mode === "out_of_depth",
            aimedElsewhere: allAimedElsewhere(newMessages, persona),
            named: namer !== undefined,
            followUp: followedUp !== undefined,
        };
        const decision = decideToSpeak(features, persona, mentioned, this.#gateRng, speakContext);
        // Answering her counts as talking to her, but only a direct ask gets chased up when she ignores it.
        const talkedTo = decision.addressed || decision.followUp;
        const overruled = features === gate.data ? {} : { addressOverruled: gate.data.addressedToMe };
        trace.record("gate.decision", { channel: key, ...idField, detail: { ...decision, ...competence, battery, features, ...overruled } });
        for (const speaker of new Set(newMessages.map(userKey))) {
            updateRelationship(
                store,
                key,
                speaker,
                speaker === askerKey ? features.towardMe : "neutral",
                talkedTo && speaker === askerKey,
                now,
                this.#people,
            );
        }
        if (decision.addressed) this.vitals.spend(ADDRESSED_BATTERY_COST);
        const reaction = reactionChoices(persona, channel.ref.platform).find(({ label }) => label === features.quickReaction);
        const reactTarget = asker ?? newest;
        const react = async () => {
            if (!reaction || !reactTarget) return;
            this.vitals.spend(REACTION_BATTERY_COST);
            if (pacing && !(await sleep(clock, readingDelay(pacing, reactTarget.text.length) + REACTION_PAUSE_MS, lease.signal))) return;
            const outcome = await this.guard.react(channel.adapter, channel.ref, reactTarget.messageId, reaction);
            if (outcome !== "reacted") return;
            // Written into its own view of the chat, or it would have no idea it had reacted.
            const own = ownMessage(
                channel.ref,
                `reaction:${reactTarget.messageId}:${reaction.label}`,
                renderOwnReaction(reaction.label, reactTarget),
                clock.now(),
                persona.name,
            );
            perception.recordOwn(own);
            this.memory.recordOwn(own);
        };
        const chain = talkedTo ? undefined : findRepeatChain(window);
        if (chain !== undefined) {
            const repeat = decideToRepeat(features, persona, this.#gateRng, speakContext);
            trace.record("gate.repeat", { channel: key, ...idField, detail: { ...repeat } });
            if (repeat.repeat) {
                perception.settle(seenSeq);
                await this.#repeat(channel, chain, lease);
                return;
            }
        }
        if (!decision.speak) {
            if (decision.addressed) this.vitals.noteIgnored(ignoreKey);
            perception.settle(seenSeq);
            // Left on read, but a reaction shows it was seen, which reads as rude rather than broken.
            const deservesReaction = decision.addressed
                ? this.#reactionRng.chance(LEFT_ON_READ_REACTION)
                : features.interest >= 0.5 && this.#reactionRng.chance(persona.lowEffort);
            if (deservesReaction) await react();
            return;
        }
        this.vitals.noteAnswered(ignoreKey);
        if (reaction && this.#reactionRng.chance(persona.lowEffort)) {
            perception.settle(seenSeq);
            trace.record("reply.reaction_only", { channel: key, ...idField, detail: { reaction: reaction.label } });
            await react();
            return;
        }

        lease.setState("composing");
        const { block: memories, recalled } = await this.memory.recall(key, newMessages);
        const lookup = await this.#maybeLookUp(key, features.lookUp, newMessages, lease.signal);
        const people = [...new Map(newMessages.map((message) => [userKey(message), message.sender.displayName]))].flatMap(([user, name]) => {
            const description = this.#describePerson(user, name, now);
            return description ? [{ name, description }] : [];
        });
        const talking = new Set(newMessages.map(userKey));
        people.push(...explainAliases(this.#people, window, recalled), ...explainClocks(this.#people, window, talking, now));
        const lowBattery = battery < LOW_BATTERY;
        const technical = competence.mode !== "casual";
        // Only a request made to her counts. Someone asking the room, or another member, is ordinary chat.
        const requested = features.asksForPicture && decision.addressed;
        const offerState = { requested, mood: day.mood, affinity: speakContext.affinity, battery };
        const { offered, declined } = technical ? NO_OFFER : await this.#offerImages(channel, newMessages, now, offerState);
        const situation = [
            ...day.notes,
            timezoneNote(channel.ref.platform, now),
            ...(lowBattery ? ["You've been chatting all day and are running out of energy for it. Keep it very short."] : []),
            ...lateReplyNote(asker && talkedTo ? now - asker.sentAt : 0),
            ...(lookup ? ["You just looked this up online and only half get it."] : []),
            ...(requested && !technical ? [pictureRequestNote(declined)] : []),
        ];
        const role = technical ? "technical" : "reply";
        const pictures = llm.canSee(role) ? choosePictures(window, firstNewIndex, features.aboutPicture, this.#options.picturesPerReply ?? 0) : [];
        const context = `${renderPeople(people)}${memories}${lookup}${renderSavedImages(offered)}`;
        const volatile = renderReplyState({ now, persona, features, competence, addressed: talkedTo, situation });
        const stable = renderReplyInstructions(persona);
        const fetched = await Promise.all(pictures.map(({ image }) => this.#fetched(channel.ref.platform, image)));
        const write = (shown: readonly ShownPicture[]) => {
            const numbers = new Map(shown.map((picture) => [picture.messageId, picture.number]));
            const images = shown.map(({ image, number }, index) => {
                const picture = fetched[index] ?? { animated: false };
                const inline = picture.frames?.sheet ?? picture.inline;
                const label = pictureLabel(number, motionOf(picture), picture.frames?.frames, picture.frames?.seconds);
                return { url: image.url, label, ...(inline ? { inline } : {}) };
            });
            return llm.generate(role, {
                stable,
                transcript: `${context}${shown.length > 0 ? renderTranscript(window, persona, firstNewIndex, numbers) : transcript}`,
                volatile,
                ...(images.length > 0 ? { images } : {}),
                schema: replySchema,
                maxOutput: technical ? TECHNICAL_MAX_OUTPUT : REPLY_MAX_OUTPUT,
                signal: lease.signal,
            });
        };
        let result = await write(pictures);
        let sawPictures = pictures.length > 0;
        if (pictures.length > 0) {
            trace.record("reply.pictures", { channel: key, ...idField, detail: { shown: pictures.length, result: result.kind } });
            const rejected = result.kind === "refused" || (result.kind === "error" && !result.retryable);
            if (rejected && !lease.signal.aborted) {
                // A picture may be what it choked on, such as a link that has expired. She answers from the descriptions and doesn't try those again.
                perception.forgetSeenImages(pictures.map((picture) => picture.messageId));
                result = await write([]);
                sawPictures = false;
            }
        }
        if (result.kind !== "ok" || !result.data) {
            // Failures never reach the chat. The trace is where the operator finds them.
            trace.record("reply.silent", { channel: key, ...idField, detail: describeFailure(result) });
            if (!lease.signal.aborted) this.#alert("reply_failed", { channel: key, ...describeFailure(result) });
            return;
        }
        if (this.#options.captureReplies) {
            this.#captureReply(key, messageId, window, {
                role,
                stable,
                transcript: `${context}${transcript}`,
                volatile,
                maxOutput: technical ? TECHNICAL_MAX_OUTPUT : REPLY_MAX_OUTPUT,
                sawPictures,
                output: result.data,
                usage: result.usage,
                memories: recalled.map(({ memory }) => memory.id),
                images: offered.map(({ id }) => id),
            });
        }

        const bursts = toBursts(result.data.messages, lowBattery ? 1 : undefined);
        const picked = offered.find(({ number }) => number === result.data?.image);
        if (bursts.length === 0 && !picked) {
            perception.settle(seenSeq);
            trace.record("reply.chose_silence", { channel: key, ...idField });
            return;
        }
        if (exceedsCodeLimit(bursts, persona.maxCodeLines)) {
            perception.settle(seenSeq);
            trace.record("reply.code_too_long", { channel: key, ...idField });
            return;
        }

        if (pacing) {
            const chars = newMessages.reduce((total, message) => total + message.text.length, 0);
            const planned = readingDelay(pacing, chars) + thinkingDelay(pacing, features.difficulty, technical, this.#pacingRng);
            if (!(await sleep(clock, planned - (clock.now() - attendStart), lease.signal))) return;
        }

        lease.setState("sending");
        for (const [index, { text, mention }] of resolveMentions(bursts, mentionablePeople(window)).entries()) {
            if (pacing && !(await this.#type(channel, typingDelay(pacing, text, this.#pacingRng, index === 0), lease.signal))) return;
            const overtakenBy = perception.newSince(seenSeq);
            if (overtakenBy.length >= ABANDON_AFTER_NEW_MESSAGES && !decision.addressed) {
                // It was only joining in, and the conversation has left without it.
                perception.settle(seenSeq);
                trace.record("reply.abandoned", { channel: key, ...idField, detail: { overtakenBy: overtakenBy.length } });
                return;
            }
            // Someone asked and the chat has moved on, so the answer needs to point back at the question.
            const quote = index === 0 && decision.addressed && overtakenBy.length >= QUOTE_AFTER_NEW_MESSAGES && asker;
            const outcome = await this.guard.send(channel.adapter, channel.ref, text, {
                signal: lease.signal,
                ...(quote ? { replyToMessageId: asker.messageId } : {}),
                ...(mention ? { mention } : {}),
            });
            if (outcome.kind === "blocked" && outcome.reason === "shadow") {
                perception.settle(seenSeq);
                this.vitals.spend(1);
                continue;
            }
            if (outcome.kind !== "sent") return;
            // Settled on the first send, so a reply cut short partway is never answered a second time.
            perception.settle(seenSeq);
            this.vitals.spend(1);
            const own = ownMessage(channel.ref, outcome.messageId, text, clock.now(), persona.name, quote ? quoteOf(quote) : undefined);
            perception.recordOwn(own);
            this.memory.recordOwn(own);
        }
        if (picked) await this.#sendSavedImage(channel, picked, seenSeq, decision.addressed, lease);
    }

    /**
     * The roll comes first, so most replies cost nothing extra. The model only picks among the few it's shown.
     * Being asked skips the wait between pictures, since the battery and the send guards already stop her being farmed for them.
     */
    /** A forward is never saved, so a reply that saw one isn't kept either. */
    #captureReply(
        key: string,
        messageId: string | undefined,
        window: readonly ChatMessage[],
        request: Omit<ReplyCaptureDraft, "channel" | "messageId" | "capturedAt" | "model" | "refs"> & {
            memories: readonly number[];
            images: readonly number[];
        },
    ): void {
        if (window.some((message) => message.forwarded)) return;
        const { memories, images, ...captured } = request;
        const messages = window.flatMap((message) => [
            message.messageId,
            ...(message.replyTo ? [message.replyTo.messageId] : []),
            ...(message.groupEvent?.quotes ? [message.groupEvent.quotes] : []),
        ]);
        const users = window.flatMap((message) => [
            ...(message.groupEvent ? message.groupEvent.involves : [userKey(message)]),
            ...(message.replyTo ? [message.replyTo.byUser] : []),
            ...(message.reactions ?? []).map((reaction) => reaction.byUser),
        ]);
        this.memory.store.captureReply({
            ...captured,
            channel: key,
            messageId,
            capturedAt: this.#options.clock.now(),
            model: this.#options.llm.modelOf(request.role) ?? "",
            refs: { messages, users, memories, images },
        });
    }

    async #offerImages(channel: Channel, newMessages: readonly ChatMessage[], now: number, state: OfferState): Promise<ImageOffer> {
        const { trace } = this.#options;
        const key = channelKey(channel.ref);
        const lastSent = this.#lastImageSentAt.get(key);
        const decline = (reason: Declined, chance?: number): ImageOffer => {
            if (state.requested) trace.record("image.declined", { channel: key, detail: { reason, ...(chance === undefined ? {} : { chance }) } });
            return { offered: [], declined: reason };
        };
        if (!channel.adapter.sendImage) return decline("nothing");
        if (!state.requested && lastSent !== undefined && now - lastSent < IMAGE_COOLDOWN_MS) return NO_OFFER;
        const chance = offerChance(this.#persona.savedImages, state);
        if (!this.#imageRng.chance(chance)) return decline("unwilling", chance);
        const usable = this.memory.store
            .savedImages()
            .filter(
                (image) => canUseHere(image, key, this.#sharing) && (image.lastSentAt === null || now - image.lastSentAt >= IMAGE_REUSE_AFTER_MS),
            );
        if (usable.length === 0) return decline("nothing", chance);
        const query = await this.#options.embedder.embed(newMessages.map((message) => message.text).join(" "), "query");
        const offered = chooseOffers(usable, query, this.#imageRng);
        const detail = { ids: offered.map(({ id }) => id).join(","), requested: state.requested, chance };
        trace.record("image.offered", { channel: key, detail });
        return { offered };
    }

    async #sendSavedImage(channel: Channel, picked: OfferedImage, seenSeq: number, addressed: boolean, lease: Lease): Promise<void> {
        const { clock, pacing, trace } = this.#options;
        const { perception } = channel;
        const key = channelKey(channel.ref);
        // It may have been forgotten while the reply was being written.
        const content = this.memory.store.savedImageContent(picked.id);
        if (!content) return;
        if (pacing && !(await this.#type(channel, typingDelay(pacing, "", this.#pacingRng, false), lease.signal))) return;
        const overtakenBy = perception.newSince(seenSeq);
        if (overtakenBy.length >= ABANDON_AFTER_NEW_MESSAGES && !addressed) {
            perception.settle(seenSeq);
            trace.record("reply.abandoned", { channel: key, detail: { overtakenBy: overtakenBy.length } });
            return;
        }
        const outcome = content.link
            ? await this.guard.send(channel.adapter, channel.ref, content.link, { signal: lease.signal })
            : await this.guard.sendImage(channel.adapter, channel.ref, content, picked.description, { signal: lease.signal });
        if (outcome.kind === "blocked" && outcome.reason === "shadow") {
            perception.settle(seenSeq);
            this.vitals.spend(1);
            return;
        }
        if (outcome.kind !== "sent") return;
        perception.settle(seenSeq);
        this.vitals.spend(1);
        this.#lastImageSentAt.set(key, clock.now());
        this.memory.store.noteImageSent(picked.id, clock.now());
        // Written into its own view of the chat, or it would have no idea what it had posted.
        const own = ownMessage(channel.ref, outcome.messageId, renderOwnImage(picked.description), clock.now(), this.#persona.name);
        perception.recordOwn(own);
        this.memory.recordOwn(own);
    }

    /** Goes by account, so a nickname alone never gets anyone treated as someone she knows. */
    #describePerson(user: string, shownAs: string, now: number): string | undefined {
        const knownAs = this.#people.nameOf(user);
        const note = this.#people.noteOf(user);
        const timezone = this.#people.timezoneOf(user);
        const parts = [
            knownAs !== undefined && knownAs !== shownAs ? `this is ${knownAs}` : undefined,
            note,
            timezone === undefined ? undefined : timeThere(timezone, now),
            describeRelationship(currentRelationship(this.memory.store, user, now, this.#people), note !== undefined),
        ].filter((part) => part !== undefined);
        return parts.length > 0 ? parts.join("; ") : undefined;
    }

    /** Sends the line as it stands, without the reply model, unless the chain has broken by the time it's typed. */
    async #repeat(channel: Channel, text: string, lease: Lease): Promise<void> {
        const { clock, pacing, trace } = this.#options;
        const { perception } = channel;
        lease.setState("composing");
        if (pacing && !(await sleep(clock, readingDelay(pacing, text.length), lease.signal))) return;
        lease.setState("sending");
        if (pacing && !(await this.#type(channel, typingDelay(pacing, text, this.#pacingRng, true), lease.signal))) return;
        if (findRepeatChain(perception.window()) !== text) {
            trace.record("reply.abandoned", { channel: lease.candidate.channel, detail: { repeat: true } });
            return;
        }
        const outcome = await this.guard.send(channel.adapter, channel.ref, text, { signal: lease.signal });
        if (outcome.kind === "blocked" && outcome.reason === "shadow") this.vitals.spend(1);
        if (outcome.kind !== "sent") return;
        this.vitals.spend(1);
        const own = ownMessage(channel.ref, outcome.messageId, text, clock.now(), this.#persona.name);
        perception.recordOwn(own);
        this.memory.recordOwn(own);
    }

    /** Pictures cost a model call, so they're only looked at once the agent is actually reading them. */
    async #lookAtImages(key: string, perception: ChannelPerception, persona: Persona, signal: AbortSignal): Promise<LookedAt[]> {
        const firstNew = perception.firstNewIndex();
        if (firstNew === undefined) return [];
        const looked: LookedAt[] = [];
        const unread = perception
            .window()
            .slice(firstNew)
            .filter((message) => !message.isSelf);
        const withImages = unread
            .filter((message) => message.images?.length && message.text.includes(IMAGE_PLACEHOLDER))
            .slice(-MAX_IMAGES_PER_ATTEND);
        for (const message of withImages) {
            const [image] = message.images ?? [];
            if (!image) continue;
            const fetched = await this.#fetched(message.platform, image);
            const look = await this.#lookAt(image, fetched, persona, signal);
            if (!look) continue;
            const text = message.text.replace(IMAGE_PLACEHOLDER, () => renderCaption(look.description, motionOf(fetched)));
            // An explicit one is never looked at again. She keeps only the description, which says nothing.
            perception.annotate(message.messageId, text, look.explicit ? undefined : image);
            this.memory.store.updateText(key, message.messageId, text);
            looked.push({ message, image, look });
        }
        // Pictures someone posted come first, and the newest forward gets what's left. Never saved and never kept, like the rest of a forward.
        const inForwards = unread
            .toReversed()
            .flatMap(({ messageId, platform, forwarded }) => forwardedImages(forwarded ?? []).map((image) => ({ messageId, platform, image })))
            .slice(0, MAX_IMAGES_PER_ATTEND - withImages.length);
        for (const { messageId, platform, image } of inForwards) {
            const fetched = await this.#fetched(platform, image);
            const look = await this.#lookAt(image, fetched, persona, signal);
            if (look) perception.describeForwardedImage(messageId, image, renderCaption(look.description, motionOf(fetched)));
        }
        return looked;
    }

    /** An animation is judged on its frames, so one that turns explicit after a harmless start is never kept or shown again. */
    async #lookAt(image: ChatImage, fetched: FetchedImage, persona: Persona, signal: AbortSignal): Promise<ImageLook | undefined> {
        const { frames } = fetched;
        const result = await this.#options.llm.generate("vision", {
            stable: renderVisionInstructions(persona),
            transcript: lookRequest(motionOf(fetched), frames?.frames, frames?.seconds),
            volatile: "",
            images: [frames ? { url: image.url, inline: frames.sheet } : image],
            schema: imageLookSchema,
            maxOutput: VISION_MAX_OUTPUT,
            signal,
        });
        // A refusal is about what the picture shows. Any other failure says nothing about it, so it stays an unread picture.
        if (result.kind === "refused") return REFUSED_LOOK;
        if (result.kind !== "ok" || !result.data) return undefined;
        const description = flattenCaption(result.data.description, MAX_CAPTION_CHARS);
        if (description === "") return undefined;
        return { ...result.data, description, useFor: flattenCaption(result.data.useFor, MAX_USE_FOR_CHARS) };
    }

    /**
     * What the picture's own file says: whether it moves, a sheet of its frames if it does, and a copy small enough to be cheap
     * to look at again. Kept against the picture itself, so it goes when its message leaves the window. One that can't be
     * fetched or decoded is taken for a still picture and shown by its link.
     */
    #fetched(platform: Platform, image: ChatImage): Promise<FetchedImage> {
        const { fetchImage, clock, pictureMaxEdge = 0 } = this.#options;
        // Discord's picker only posts GIFs, and there's no file of theirs to fetch.
        if (image.link) return Promise.resolve({ animated: true });
        if (!fetchImage) return Promise.resolve({ animated: false });
        const existing = this.#fetchedImages.get(image);
        if (existing) return existing;
        const fetched = downloadImage(fetchImage, platform, image.url, clock).then(async (download): Promise<FetchedImage> => {
            if (download.kind !== "ok") return { animated: false };
            if (await isAnimated(download.bytes)) {
                // Frames have to be laid out whatever the shrinking setting, since an animation can't be shown as it is.
                const frames = await frameSheet(download.bytes, pictureMaxEdge || DEFAULT_SHEET_EDGE);
                return { animated: true, ...(frames ? { frames } : {}) };
            }
            const inline = pictureMaxEdge > 0 ? await shrinkImage(download.bytes, pictureMaxEdge) : undefined;
            return { animated: false, ...(inline ? { inline } : {}) };
        });
        this.#fetchedImages.set(image, fetched);
        return fetched;
    }

    /** Runs once she has really read them, so a picture that was only glanced at before a failure is never kept. */
    #considerKeeping(key: string, looked: readonly LookedAt[]): void {
        const { trace } = this.#options;
        for (const { message, image, look } of looked) {
            const verdict = judgeImage(look, message, this.#persona.savedImages.pickiness);
            trace.record("image.judged", { channel: key, messageId: message.messageId, detail: { verdict, appeal: look.appeal } });
            // In the background, so saving a picture never holds up reading the chat.
            if (verdict === "keep") this.#inBackground(this.#keepImage(key, message, image, look));
        }
    }

    #fetchToKeep(platform: Platform, image: ChatImage): DownloadResult | Promise<DownloadResult> {
        if (image.link !== undefined) return linkedImage(image.link);
        const { fetchImage, clock } = this.#options;
        return fetchImage ? downloadImage(fetchImage, platform, image.url, clock) : { kind: "failed", reason: "downloads_off" };
    }

    async #keepImage(key: string, message: ChatMessage, image: ChatImage, look: ImageLook): Promise<void> {
        const { clock, trace, embedder } = this.#options;
        const { store } = this.memory;
        const user = userKey(message);
        const idFields = { channel: key, messageId: message.messageId };
        if (store.savedImagesSince(this.#people.accountsOf(user), clock.now() - DAY_MS) >= MAX_IMAGES_KEPT_PER_PERSON_PER_DAY) {
            trace.record("image.skipped", { ...idFields, detail: { reason: "daily_quota" } });
            return;
        }
        const download = await this.#fetchToKeep(message.platform, image);
        if (download.kind === "failed") {
            trace.record("image.skipped", { ...idFields, detail: { reason: download.reason } });
            return;
        }
        if (store.hasSavedImage(download.sha256)) {
            trace.record("image.skipped", { ...idFields, detail: { reason: "already_saved" } });
            return;
        }
        const embedding = await embedder.embed(`${look.useFor} ${look.description}`, "passage");
        // They may have opted out while this was downloading, and nothing of theirs can be written after that.
        if (this.#state.isOptedOut(user)) return;
        const id = store.saveImage({
            sha256: download.sha256,
            scope: key,
            messageId: message.messageId,
            userKey: user,
            mime: download.mime,
            bytes: download.bytes,
            description: look.description,
            useFor: look.useFor,
            appeal: look.appeal,
            embedding,
            embeddingModel: embedding ? embedder.modelId : null,
            savedAt: clock.now(),
            link: download.link,
        });
        const trimmed = store.trimSavedImages(this.#persona.savedImages.maxKept);
        trace.record("image.saved", { ...idFields, detail: { id, mime: download.mime, size: download.bytes.length, trimmed } });
    }

    /**
     * At most one link per read, and only if curiosity strikes and today's share has room. Runs before the gate, so what she read
     * there is part of the chat she decides on. The result replaces the link in the text, so deletion and opt-out cover it too.
     */
    async #maybeOpenLink(key: string, perception: ChannelPerception, persona: Persona, signal: AbortSignal): Promise<void> {
        const { links: opener, trace, clock } = this.#options;
        const { curiosity, dailyCap } = persona.links;
        const firstNew = perception.firstNewIndex();
        if (!opener || curiosity <= 0 || firstNew === undefined || this.vitals.linksToday() >= dailyCap) return;
        const now = clock.now();
        for (const [url, at] of this.#consideredLinks) if (now - at > LINK_MEMORY_MS) this.#consideredLinks.delete(url);
        const perPerson = Math.max(1, Math.ceil(dailyCap * LINK_SHARE_PER_PERSON));
        const candidate = pickLink(
            perception.window().slice(firstNew),
            persona.maxCharsRead,
            (url, message) => this.#consideredLinks.has(url) || this.vitals.linksFrom(this.#people.personOf(userKey(message))) >= perPerson,
        );
        if (!candidate) return;
        const { message, link } = candidate;
        const idFields = { channel: key, messageId: message.messageId };
        this.#consideredLinks.set(link.url, now);
        const chance = openChance(curiosity, { addressed: isAddressed(message), lowBattery: this.vitals.battery() < LOW_BATTERY });
        if (!this.#linkRng.chance(chance)) {
            trace.record("link.skipped", { ...idFields, detail: { reason: "not_curious" } });
            return;
        }
        const user = userKey(message);
        this.vitals.noteLink(this.#people.personOf(user));
        const controller = new AbortController();
        const cancelTimeout = clock.setTimer(LINK_TIMEOUT_MS, () => controller.abort());
        const outcome = await opener.open(link.url, AbortSignal.any([signal, controller.signal])).finally(cancelTimeout);
        if (outcome.kind === "skipped") {
            trace.record("link.skipped", { ...idFields, detail: { reason: outcome.reason, site: outcome.site } });
            return;
        }
        // It may have been taken back, edited, or its author may have opted out while the page was loading.
        const current = perception.window().find((candidate) => candidate.messageId === message.messageId);
        const at = current?.text.indexOf(link.url) ?? -1;
        if (!current || at < 0 || this.#state.isOptedOut(user)) {
            trace.record("link.skipped", { ...idFields, detail: { reason: "gone", site: outcome.site } });
            return;
        }
        const text = `${current.text.slice(0, at)}${outcome.caption}${current.text.slice(at + link.url.length)}`;
        perception.noteLink(message.messageId, text, { url: link.url, caption: outcome.caption });
        this.memory.store.updateText(key, message.messageId, text);
        trace.record("link.read", { ...idFields, detail: { site: outcome.site, layer: outcome.layer } });
    }

    /** Only when the gate spotted something unfamiliar, curiosity strikes, and today's cap has room. */
    async #maybeLookUp(key: string, query: string, newMessages: readonly ChatMessage[], signal: AbortSignal): Promise<string> {
        const { search, trace } = this.#options;
        const topic = query.trim();
        if (!search || topic === "") return "";
        if (this.vitals.searchesToday() >= this.#persona.search.dailyCap) return "";
        if (newMessages.some((message) => topic.includes(message.sender.displayName))) {
            trace.record("search.skipped_personal", { channel: key });
            return "";
        }
        if (!this.#searchRng.chance(this.#persona.search.curiosity)) return "";
        this.vitals.noteSearch();
        const result = await search.search(topic, signal);
        trace.record("search.done", { channel: key, detail: { query: topic, note: result.kind === "found" ? result.note : "" } });
        return result.kind === "found" ? renderLookup(result.note) : "";
    }

    /** Shows the typing indicator for the given time. Resolves false if attention was pulled away. */
    async #type(channel: Channel, durationMs: number, signal: AbortSignal): Promise<boolean> {
        let remaining = durationMs;
        while (remaining > 0) {
            await this.guard.typing(channel.adapter, channel.ref);
            const step = Math.min(remaining, TYPING_REFRESH_MS);
            if (!(await sleep(this.#options.clock, step, signal))) return false;
            remaining -= step;
        }
        return !signal.aborted;
    }
}

function toConversationMessage(message: ChatMessage): ConversationMessage {
    return {
        messageId: message.messageId,
        senderName: message.sender.displayName,
        senderKey: userKey(message),
        isSelf: message.isSelf,
        isEvent: message.groupEvent !== undefined,
        isShadow: false,
        addressed: isAddressed(message),
        text: message.text,
        sentAt: message.sentAt,
        reactions: (message.reactions ?? []).map(({ emoji, by }) => ({ emoji, by })),
        isReply: message.replyToMessageId !== undefined,
        quoted: message.replyTo ? { senderName: message.replyTo.by, text: message.replyTo.text } : undefined,
        forwarded: message.forwarded?.map(toForwardedView),
    };
}

function toForwardedView({ by, text, forwarded }: ForwardedLine): ForwardedView {
    return { by, text, forwarded: forwarded?.map(toForwardedView) };
}

function quoteOf(message: ChatMessage): QuotedMessage {
    return {
        messageId: message.messageId,
        by: message.sender.displayName,
        byUser: userKey(message),
        text: message.text,
        isSelf: message.isSelf,
    };
}

function withShadowSends(messages: readonly ConversationMessage[], shadowSends: readonly ConversationMessage[]): ConversationMessage[] {
    const merged = [...messages];
    for (const shadow of shadowSends) {
        const next = merged.findIndex((message) => message.sentAt > shadow.sentAt);
        merged.splice(next === -1 ? merged.length : next, 0, shadow);
    }
    return merged;
}

function isSpoken(message: ChatMessage): boolean {
    return message.groupEvent === undefined;
}

function lateReplyNote(ageMs: number): string[] {
    return ageMs > LATE_REPLY_MS ? [`You're only just seeing this, about ${Math.round(ageMs / 60_000)} minutes after it was sent.`] : [];
}

/** She has to be told when none are coming, or she'd promise a picture she has no way to post. */
function pictureRequestNote(declined: Declined | undefined): string {
    if (declined === "unwilling") {
        return "You were asked for a picture, but you can't be bothered to dig one up right now. You aren't sending one, so don't act as if you did.";
    }
    if (declined === "nothing") {
        return "You were asked for a picture, but you have nothing saved that you could post here right now. You aren't sending one, so don't act as if you did.";
    }
    return "You were asked for a picture, and the ones in <saved_images> came to mind. Send one if it's close to what they asked for.";
}

function describeFailure(result: { kind: string; detail?: string }): Record<string, unknown> {
    return { result: result.kind, ...(result.detail ? { error: result.detail } : {}) };
}

function ownMessage(ref: ChannelRef, messageId: string, text: string, sentAt: number, name: string, replyTo?: QuotedMessage): ChatMessage {
    return {
        ...ref,
        messageId,
        text,
        sentAt,
        sender: { id: "self", displayName: name, isBot: false },
        mentionsSelf: false,
        repliesToSelf: false,
        ...(replyTo ? { replyTo, replyToMessageId: replyTo.messageId } : {}),
        isSelf: true,
        isBacklog: false,
    };
}

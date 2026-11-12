import type { ChatMessage } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";
import type { LinkReader } from "../llm/links.ts";
import { isAddressed } from "../perception/channel.ts";
import { LINK_CAPTION_PREFIX, linkCaption } from "./caption.ts";
import { classifyLink, OTHER_SITE } from "./classify.ts";
import { type FoundLink, findLinks } from "./find.ts";
import { type LinkRejection, vetLink } from "./hygiene.ts";
import { readKnownSite, type SiteFetcher, type SiteOptions } from "./sites.ts";

/** A platform's own preview, which she's already seen, so there's nothing more to open. */
const CARD_PREFIX = "[card:";

/** Which way a page was read, for the trace: a known site's own API, the vendor's fetch, or the bot itself. */
export type LinkLayer = "site" | "reader" | "direct";

export type LinkSkip = LinkRejection | "looks_private" | "unreadable" | "failed";

export type LinkOutcome = { kind: "read"; site: string; layer: LinkLayer; caption: string } | { kind: "skipped"; site: string; reason: LinkSkip };

/** Reads a page from the bot's own machine. Only the hardened fetcher in `direct.ts` fits, and only when the operator turns it on. */
export type DirectReader = (url: URL, signal: AbortSignal) => Promise<{ title?: string; gist?: string } | undefined>;

export type LinkOpenerOptions = {
    clock: Clock;
    /** Without it, known sites go to the reader like any other page. */
    sites?: { fetcher: SiteFetcher; options: SiteOptions } | undefined;
    reader?: LinkReader | undefined;
    direct?: DirectReader | undefined;
    blockedHosts?: readonly string[];
};

export type LinkCandidate = { message: ChatMessage; link: FoundLink };

/** How likely she is to open a link this time. Being sent one is like being asked to look, and a flat battery makes her lazier. */
export function openChance(curiosity: number, context: { addressed: boolean; lowBattery: boolean }): number {
    const base = context.addressed ? 1 - (1 - curiosity) ** 2 : curiosity;
    return context.lowBattery ? base / 2 : base;
}

/**
 * The one link she might open while reading these messages: newest first, someone sending her one before anything else.
 * Only links in what she actually read count, so one past her reading limit, in a forward or in a quote never does.
 */
export function pickLink(
    messages: readonly ChatMessage[],
    maxCharsRead: number,
    skip: (url: string, message: ChatMessage) => boolean,
): LinkCandidate | undefined {
    const eligible = messages.filter(
        (message) =>
            !message.isSelf &&
            !message.isBacklog &&
            !message.groupEvent &&
            !message.text.includes(CARD_PREFIX) &&
            !message.text.includes(LINK_CAPTION_PREFIX),
    );
    const newestFirst = eligible.toReversed();
    const sorted = [...newestFirst.filter(isAddressed), ...newestFirst.filter((message) => !isAddressed(message))];
    for (const message of sorted) {
        const link = findLinks(message.text).find(({ url, start }) => start < maxCharsRead && !skip(url, message));
        if (link) return { message, link };
    }
    return undefined;
}

/** Opens one link, trying the safest way first. Never throws: a page that can't be read is skipped, and nothing about it reaches the chat. */
export class LinkOpener {
    #options: LinkOpenerOptions;

    constructor(options: LinkOpenerOptions) {
        this.#options = options;
    }

    async open(raw: string, signal: AbortSignal): Promise<LinkOutcome> {
        const { sites, reader, direct, clock, blockedHosts = [] } = this.#options;
        const vetted = vetLink(raw, blockedHosts);
        if (!vetted.ok) return { kind: "skipped", site: OTHER_SITE, reason: vetted.reason };
        const known = classifyLink(vetted.url, vetted.host);
        try {
            if (known && sites) {
                // Only the ID went out, so a failure here says the page is gone or private, and the address goes nowhere else.
                const reading = await readKnownSite(known, sites.fetcher, clock, signal, sites.options);
                return reading
                    ? { kind: "read", site: known.site, layer: "site", caption: linkCaption(vetted.host, reading) }
                    : { kind: "skipped", site: known.site, reason: "unreadable" };
            }
            const site = known?.site ?? OTHER_SITE;
            if (vetted.looksPrivate) return { kind: "skipped", site, reason: "looks_private" };
            const read = reader ? await reader.read(vetted.url.href, vetted.url.hostname, signal) : { kind: "nothing" as const };
            if (read.kind === "explicit") return { kind: "read", site, layer: "reader", caption: linkCaption(vetted.host, { explicit: true }) };
            if (read.kind === "read") return { kind: "read", site, layer: "reader", caption: linkCaption(vetted.host, read) };
            const page = direct && !signal.aborted ? await direct(vetted.url, signal) : undefined;
            return page
                ? { kind: "read", site, layer: "direct", caption: linkCaption(vetted.host, page) }
                : { kind: "skipped", site, reason: "unreadable" };
        } catch {
            return { kind: "skipped", site: known?.site ?? OTHER_SITE, reason: "failed" };
        }
    }
}

import type { Clock } from "../lib/clock.ts";
import { classifyLink, type KnownLink } from "./classify.ts";
import { vetLink } from "./hygiene.ts";

/** What she took in from a page. Each part is the page's own words, so it's data and never instructions. */
export type LinkReading = { title?: string; by?: string; gist?: string; explicit?: boolean };

/**
 * The two kinds of request the known sites need. `json` never follows a redirect, and `redirect` only reads where one points, without going there.
 * Injected, so tests can see exactly what would have left the bot.
 */
export type SiteFetcher = {
    json(url: string, signal: AbortSignal): Promise<unknown>;
    redirect(url: string, signal: AbortSignal): Promise<string | undefined>;
};

export type SiteOptions = { youtubeApiKey?: string | undefined };

const MAX_RESPONSE_BYTES = 64_000;
/** For the whole read, which is two requests for a b23.tv link. */
const READ_TIMEOUT_MS = 8000;
/** Bilibili answers a browser's user agent from a server with a captcha page, so the bot says what it is. */
const USER_AGENT = "akanebot (link preview)";
const MAX_TITLE_CHARS = 150;
const MAX_BY_CHARS = 60;
const MAX_GIST_CHARS = 400;

async function readCapped(response: Response): Promise<string> {
    if (!response.body) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) throw new Error("too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export const httpSiteFetcher: SiteFetcher = {
    async json(url, signal) {
        const response = await fetch(url, { redirect: "error", signal, headers: { accept: "application/json", "user-agent": USER_AGENT } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.headers.get("content-type")?.includes("json")) throw new Error("not json");
        return JSON.parse(await readCapped(response));
    },
    async redirect(url, signal) {
        const response = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT } });
        await response.body?.cancel();
        return response.status >= 300 && response.status < 400 ? (response.headers.get("location") ?? undefined) : undefined;
    },
};

const ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
};

/** Reduces a scrap of HTML to its words. Only ever used on a site's own preview markup, never to render anything. */
export function htmlToText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
            if (name.startsWith("#")) {
                const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
                return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
            }
            return ENTITIES[name.toLowerCase()] ?? entity;
        })
        .replace(/\s+/g, " ")
        .trim();
}

function field(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/\s+/g, " ").trim().slice(0, max);
    return text === "" ? undefined : text;
}

function reading(title: unknown, by: unknown, gist: unknown): LinkReading | undefined {
    const parts = { title: field(title, MAX_TITLE_CHARS), by: field(by, MAX_BY_CHARS), gist: field(gist, MAX_GIST_CHARS) };
    if (!parts.title && !parts.gist) return undefined;
    return Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined));
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
    return typeof value === "object" && value !== null ? (value as Json) : {};
}

/** Without a key YouTube only gives the title and channel. With one its Data API adds the description. */
async function readYoutube(id: string, fetcher: SiteFetcher, signal: AbortSignal, options: SiteOptions): Promise<LinkReading | undefined> {
    if (options.youtubeApiKey) {
        const params = new URLSearchParams({ part: "snippet", id, key: options.youtubeApiKey });
        const data = asObject(await fetcher.json(`https://www.googleapis.com/youtube/v3/videos?${params}`, signal));
        const items = Array.isArray(data.items) ? data.items : [];
        const snippet = asObject(asObject(items[0]).snippet);
        return reading(snippet.title, snippet.channelTitle, snippet.description);
    }
    const params = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: "json" });
    const data = asObject(await fetcher.json(`https://www.youtube.com/oembed?${params}`, signal));
    return reading(data.title, data.author_name, undefined);
}

/** The post's text is the first paragraph of the embed markup. Links in it are dropped, and a picture is only mentioned. */
async function readTweet(id: string, fetcher: SiteFetcher, signal: AbortSignal): Promise<LinkReading | undefined> {
    // biome-ignore lint/style/useNamingConvention: X's parameter name
    const params = new URLSearchParams({ url: `https://twitter.com/i/status/${id}`, omit_script: "1", dnt: "true" });
    const data = asObject(await fetcher.json(`https://publish.x.com/oembed?${params}`, signal));
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(typeof data.html === "string" ? data.html : "")?.[1] ?? "";
    const text = htmlToText(paragraph)
        .replace(/\bpic\.(?:twitter|x)\.com\/\S+/g, "(picture)")
        .replace(/https?:\/\/\S+/g, "")
        .trim();
    return reading(undefined, data.author_name, text);
}

async function readBilibili(link: KnownLink, fetcher: SiteFetcher, signal: AbortSignal): Promise<LinkReading | undefined> {
    let id = link.id;
    if (link.short) {
        // b23.tv only says where it leads. That must be a Bilibili video, or nothing is read.
        const location = await fetcher.redirect(`https://b23.tv/${link.id}`, signal);
        const vetted = location ? vetLink(location) : undefined;
        const target = vetted?.ok ? classifyLink(vetted.url, vetted.host) : undefined;
        if (target?.site !== "bilibili" || target.short) return undefined;
        id = target.id;
    }
    const params = new URLSearchParams(id.startsWith("av") ? { aid: id.slice(2) } : { bvid: id });
    const data = asObject(await fetcher.json(`https://api.bilibili.com/x/web-interface/view?${params}`, signal));
    if (data.code !== 0) return undefined;
    const video = asObject(data.data);
    return reading(video.title, asObject(video.owner).name, video.desc);
}

async function readGithub(id: string, fetcher: SiteFetcher, signal: AbortSignal): Promise<LinkReading | undefined> {
    const data = asObject(await fetcher.json(`https://api.github.com/repos/${id}`, signal));
    const language = typeof data.language === "string" ? ` (${data.language})` : "";
    const description = typeof data.description === "string" ? data.description : "";
    return reading(data.full_name, undefined, `${description}${language}`);
}

/** Reads a known site from its own API. Every request is rebuilt from the ID alone. */
export async function readKnownSite(link: KnownLink, fetcher: SiteFetcher, clock: Clock, signal: AbortSignal, options: SiteOptions = {}) {
    const controller = new AbortController();
    const cancelTimeout = clock.setTimer(READ_TIMEOUT_MS, () => controller.abort());
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
        switch (link.site) {
            case "youtube":
                return await readYoutube(link.id, fetcher, combined, options);
            case "x":
                return await readTweet(link.id, fetcher, combined);
            case "bilibili":
                return await readBilibili(link, fetcher, combined);
            case "github":
                return await readGithub(link.id, fetcher, combined);
        }
    } finally {
        cancelTimeout();
    }
}

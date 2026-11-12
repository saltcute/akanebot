import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import type { Clock } from "../lib/clock.ts";
import { isPublicAddress } from "./address.ts";
import { vetLink } from "./hygiene.ts";
import type { DirectReader } from "./open.ts";
import { htmlToText } from "./sites.ts";

const MAX_PAGE_BYTES = 256_000;
const READ_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_TITLE_CHARS = 150;
const MAX_GIST_CHARS = 400;
const USER_AGENT = "akanebot (link preview)";

export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;

/** `close` drops the connection without reading the rest. */
export type PageResponse = { status: number; location: string | undefined; contentType: string; body: AsyncIterable<Uint8Array>; close(): void };

/** Fetches one URL from exactly the address given, without following redirects. Injected, so tests never touch the network. */
export type PinnedGet = (url: URL, address: { address: string; family: number }, signal: AbortSignal) => Promise<PageResponse>;

const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Connects to the address that was checked rather than looking the name up again, so a name that resolves to a public address
 * once and a private one the next time can't slip through. The certificate is still checked against the name.
 */
export const pinnedHttpsGet: PinnedGet = (url, address, signal) =>
    new Promise((resolve, reject) => {
        const outgoing = request(
            {
                host: url.hostname,
                servername: url.hostname,
                port: 443,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                agent: false,
                signal,
                headers: { accept: "text/html", "accept-encoding": "identity", "user-agent": USER_AGENT },
                lookup: (_hostname, options, callback) => {
                    if ((options as { all?: boolean }).all) (callback as (error: null, addresses: unknown[]) => void)(null, [address]);
                    else callback(null, address.address, address.family);
                },
            },
            (response) =>
                resolve({
                    status: response.statusCode ?? 0,
                    location: response.headers.location,
                    contentType: response.headers["content-type"] ?? "",
                    body: response,
                    close: () => response.destroy(),
                }),
        );
        outgoing.on("error", reject);
        outgoing.end();
    });

/** Stops at the cap rather than failing: a page's title and description come first, so the start is all that's needed. */
async function readStart(body: AsyncIterable<Uint8Array>, contentType: string): Promise<string> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= MAX_PAGE_BYTES) break;
    }
    const bytes = Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES);
    const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

function attribute(tag: string, name: string): string | undefined {
    return new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
        .exec(tag)
        ?.slice(1)
        .find((value) => value !== undefined);
}

/** Only the page's own summary of itself: its title and its description tags. Never its body, never anything that runs. */
export function pageSummary(html: string): { title?: string; gist?: string } | undefined {
    const meta = new Map<string, string>();
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
        const key = (attribute(tag, "property") ?? attribute(tag, "name"))?.toLowerCase();
        const content = attribute(tag, "content");
        if (key && content && !meta.has(key)) meta.set(key, content);
    }
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const title = htmlToText(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag ?? "").slice(0, MAX_TITLE_CHARS);
    const gist = htmlToText(meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description") ?? "").slice(0, MAX_GIST_CHARS);
    if (!title && !gist) return undefined;
    return { ...(title ? { title } : {}), ...(gist ? { gist } : {}) };
}

async function resolvePublic(host: string, resolve: Resolver): Promise<{ address: string; family: number } | undefined> {
    const addresses = await resolve(host);
    // Every address has to be public, since which one gets used isn't up to the bot.
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address)) ? addresses[0] : undefined;
}

/**
 * Reads a page from the bot's own machine, which the address's owner will see. Only https on the standard port, only HTML,
 * every redirect checked again like a new link, and only the start of the page. Off unless the operator turns it on.
 */
export function createDirectReader(options: { clock: Clock; blockedHosts?: readonly string[]; resolve?: Resolver; get?: PinnedGet }): DirectReader {
    const { clock, blockedHosts = [], resolve = systemResolver, get = pinnedHttpsGet } = options;
    return async (start, outerSignal) => {
        const controller = new AbortController();
        const cancelTimeout = clock.setTimer(READ_TIMEOUT_MS, () => controller.abort());
        const signal = AbortSignal.any([outerSignal, controller.signal]);
        try {
            let url = start;
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                if (url.protocol !== "https:" || url.port !== "") return undefined;
                const address = await resolvePublic(url.hostname, resolve);
                if (!address || signal.aborted) return undefined;
                const response = await get(url, address, signal);
                const html = response.status === 200 && /^text\/html\b/i.test(response.contentType);
                if (!html) response.close();
                if (response.status >= 300 && response.status < 400) {
                    const vetted = response.location ? vetLink(new URL(response.location, url).href, blockedHosts) : undefined;
                    if (!vetted?.ok || vetted.looksPrivate) return undefined;
                    url = vetted.url;
                    continue;
                }
                if (!html) return undefined;
                try {
                    return pageSummary(await readStart(response.body, response.contentType));
                } finally {
                    response.close();
                }
            }
            return undefined;
        } catch {
            return undefined;
        } finally {
            cancelTimeout();
        }
    };
}

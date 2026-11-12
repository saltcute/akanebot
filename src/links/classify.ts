/**
 * Sites read from their own fixed endpoints. Only the ID leaves the bot, so a look-alike host or a crafted path can't steer the request.
 * `short` is a b23.tv code, which has to be looked up before it names a video.
 */
export type KnownLink = { site: "youtube" | "x" | "bilibili" | "github"; id: string; short?: true };

/** What the trace calls a link that isn't one of the known sites. */
export const OTHER_SITE = "web";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TWEET_ID = /^\d{1,20}$/;
const BILIBILI_ID = /^(?:BV[0-9A-Za-z]{10}|av\d{1,12})$/;
const B23_CODE = /^[0-9A-Za-z]{4,12}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** First path segments on github.com that are pages of the site rather than accounts. */
const GITHUB_PAGES = new Set([
    "about",
    "apps",
    "collections",
    "enterprise",
    "events",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "new",
    "notifications",
    "orgs",
    "pricing",
    "pulls",
    "search",
    "settings",
    "sponsors",
    "topics",
    "trending",
]);

function idIf(pattern: RegExp, value: string | null | undefined): string | undefined {
    return value && pattern.test(value) ? value : undefined;
}

function youtubeId(host: string, parts: readonly string[], url: URL): string | undefined {
    if (host === "youtu.be") return idIf(YOUTUBE_ID, parts[0]);
    if (host !== "youtube.com" && host !== "music.youtube.com") return undefined;
    if (parts[0] === "watch") return idIf(YOUTUBE_ID, url.searchParams.get("v"));
    return ["shorts", "live", "embed"].includes(parts[0] ?? "") ? idIf(YOUTUBE_ID, parts[1]) : undefined;
}

function tweetId(host: string, parts: readonly string[]): string | undefined {
    if (host !== "x.com" && host !== "twitter.com") return undefined;
    const at = parts.indexOf("status");
    // Either /<user>/status/<id> or /i/status/<id> and /i/web/status/<id>.
    return at === 1 || (parts[0] === "i" && at >= 1) ? idIf(TWEET_ID, parts[at + 1]) : undefined;
}

function bilibili(host: string, parts: readonly string[]): KnownLink | undefined {
    if (host === "bilibili.com" && parts[0] === "video") {
        const id = idIf(BILIBILI_ID, parts[1]);
        return id ? { site: "bilibili", id } : undefined;
    }
    if (host !== "b23.tv" || parts.length !== 1) return undefined;
    const direct = idIf(BILIBILI_ID, parts[0]);
    if (direct) return { site: "bilibili", id: direct };
    const code = idIf(B23_CODE, parts[0]);
    return code ? { site: "bilibili", id: code, short: true } : undefined;
}

function githubRepo(host: string, parts: readonly string[]): string | undefined {
    const [owner, repo] = parts;
    if (host !== "github.com" || !owner || !repo || GITHUB_PAGES.has(owner.toLowerCase())) return undefined;
    const name = repo.replace(/\.git$/, "");
    return GITHUB_OWNER.test(owner) && GITHUB_REPO.test(name) && name !== "." && name !== ".." ? `${owner}/${name}` : undefined;
}

/** `host` is the vetted host, without `www.`, `m.` or `mobile.`. */
export function classifyLink(url: URL, host: string): KnownLink | undefined {
    const parts = url.pathname.split("/").filter(Boolean);
    const youtube = youtubeId(host, parts, url);
    if (youtube) return { site: "youtube", id: youtube };
    const tweet = tweetId(host, parts);
    if (tweet) return { site: "x", id: tweet };
    const video = bilibili(host, parts);
    if (video) return video;
    const repo = githubRepo(host, parts);
    return repo ? { site: "github", id: repo } : undefined;
}

import { isIP } from "node:net";

/** Why a link is never opened, as the trace records it. */
export type LinkRejection = "unsafe_url" | "action_link" | "blocked_host";

/** A link fit to open, with tracking stripped. `looksPrivate` means only the ID may leave the bot: a third party must never be handed the whole address. */
export type VettedLink = { ok: true; url: URL; host: string; looksPrivate: boolean };

export type Vetting = VettedLink | { ok: false; reason: LinkRejection };

const MAX_URL_CHARS = 500;
/** Names that only ever mean a machine on the same network. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".arpa", ".onion", ".test", ".invalid"];
/** Parameters that only say who shared a link and where from, so dropping them changes nothing about the page. */
const TRACKING_PARAMS = new Set([
    "fbclid",
    "gclid",
    "igshid",
    "igsh",
    "si",
    "mc_cid",
    "mc_eid",
    "ref_src",
    "ref_url",
    "vd_source",
    "share_source",
    "share_medium",
    "share_plat",
    "share_session_id",
    "share_tag",
    "share_from",
    "from_spmid",
    "unique_k",
    "bbid",
    "buvid",
    "up_id",
    "is_story_h5",
    "timestamp",
    "xsec_token",
    "xsec_source",
]);
const TRACKING_PREFIXES = ["utm_", "spm"];
/** Opening one of these is joining something. */
const INVITE_HOSTS = ["discord.gg", "discord.new", "chat.whatsapp.com", "qm.qq.com", "join.slack.com"];
/** A link whose path starts with one of these may do something when fetched, as an unsubscribe link does. */
const ACTION_WORDS = new Set([
    "unsubscribe",
    "subscribe",
    "confirm",
    "verify",
    "verification",
    "reset",
    "login",
    "logout",
    "signin",
    "signup",
    "register",
    "oauth",
    "oauth2",
    "authorize",
    "auth",
    "invite",
    "join",
    "joinchat",
    "pay",
    "checkout",
    "vote",
    "activate",
    "approve",
    "redeem",
    "claim",
    "delete",
]);
/** Parameters that grant access. A link carrying one opens something meant for one person. */
const SECRET_PARAM =
    /^(?:token|access_token|id_token|auth|authkey|key|apikey|api_key|sig|signature|code|session|sessionid|sid|secret|password|pwd|passwd|ticket|otp|x-amz-.*|x-goog-.*)$/i;
/** Document, drive and file-sharing hosts, where a link someone posts is usually theirs alone. */
const PRIVATE_HOSTS = [
    "docs.google.com",
    "drive.google.com",
    "dropbox.com",
    "dropboxusercontent.com",
    "onedrive.live.com",
    "1drv.ms",
    "sharepoint.com",
    "box.com",
    "icloud.com",
    "mega.nz",
    "mega.io",
    "wetransfer.com",
    "we.tl",
    "notion.so",
    "pan.baidu.com",
    "aliyundrive.com",
    "alipan.com",
    "docs.qq.com",
    "kdocs.cn",
    "shimo.im",
    "feishu.cn",
    "larksuite.com",
    "123pan.com",
];

export function hostMatches(host: string, list: readonly string[]): boolean {
    return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isUnsafe(url: URL, raw: string): boolean {
    const host = url.hostname;
    return (
        raw.length > MAX_URL_CHARS ||
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        host.startsWith("[") ||
        isIP(host) !== 0 ||
        !host.includes(".") ||
        host === "localhost" ||
        LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
}

function isAction(url: URL, host: string): boolean {
    if (hostMatches(host, INVITE_HOSTS)) return true;
    const segments = url.pathname.toLowerCase().split("/");
    if ((host === "t.me" || host === "telegram.me") && segments.some((segment) => segment.startsWith("+"))) return true;
    return segments.some((segment) => ACTION_WORDS.has(segment.split(/[-_.]/)[0] ?? ""));
}

/** A long run of letters mixed with digits is a key or an unlisted ID, not a word. Slugs split into words, so they pass. */
function hasRandomSegment(url: URL): boolean {
    return url.pathname
        .split("/")
        .flatMap((segment) => segment.split(/[-_.]/))
        .some((piece) => piece.length >= 20 && /\d/.test(piece) && /[a-z]/i.test(piece));
}

/** Decides in code, before anything leaves the bot, whether a link may be opened at all. */
export function vetLink(raw: string, blockedHosts: readonly string[] = []): Vetting {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: "unsafe_url" };
    }
    url.hostname = url.hostname.replace(/\.$/, "");
    if (isUnsafe(url, raw)) return { ok: false, reason: "unsafe_url" };
    const host = url.hostname.replace(/^(?:www|m|mobile)\./, "");
    if (isAction(url, host)) return { ok: false, reason: "action_link" };
    if (
        hostMatches(host, PRIVATE_HOSTS) ||
        hostMatches(
            host,
            blockedHosts.map((entry) => entry.toLowerCase()),
        )
    )
        return { ok: false, reason: "blocked_host" };
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
        const lower = name.toLowerCase();
        if (TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) url.searchParams.delete(name);
    }
    const looksPrivate = [...url.searchParams.keys()].some((name) => SECRET_PARAM.test(name)) || hasRandomSegment(url);
    return { ok: true, url, host, looksPrivate };
}

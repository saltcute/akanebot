import { createHash } from "node:crypto";
import type { Platform } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";

/** The adapters already refuse to describe anything larger. */
export const MAX_IMAGE_BYTES = 5_000_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/** Links come from the platform, but the bot itself fetches them, so they may only point at where that platform keeps pictures. The simulator's are typed by the operator. */
const IMAGE_HOSTS: Readonly<Record<Platform, readonly string[] | undefined>> = {
    discord: ["cdn.discordapp.com", "media.discordapp.net"],
    qq: ["qq.com", "qq.com.cn", "qpic.cn", "qlogo.cn"],
    cli: undefined,
};

export type ImageFetcher = (url: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
export type DownloadResult = { kind: "ok"; bytes: Uint8Array; mime: string; sha256: string } | { kind: "failed"; reason: string };

/** Counts while reading, because a platform's stated size is only a claim. A redirect could lead anywhere, so it fails instead. */
export const fetchOverHttp: ImageFetcher = async (url, maxBytes, signal) => {
    const response = await fetch(url, { redirect: "error", signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error("too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

export function isImageSource(platform: Platform, url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hosts = IMAGE_HOSTS[platform];
    return !hosts || hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

/** Goes by the file's own first bytes, never the server's word. SVG can carry scripts, so it isn't on the list. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
    const starts = (...expected: number[]): boolean => expected.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
    if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return undefined;
}

export async function downloadImage(fetchImage: ImageFetcher, platform: Platform, url: string, clock: Clock): Promise<DownloadResult> {
    if (!isImageSource(platform, url)) return { kind: "failed", reason: "unexpected_host" };
    const controller = new AbortController();
    const cancelTimeout = clock.setTimer(DOWNLOAD_TIMEOUT_MS, () => controller.abort());
    try {
        const bytes = await fetchImage(url, MAX_IMAGE_BYTES, controller.signal);
        if (bytes.length > MAX_IMAGE_BYTES) return { kind: "failed", reason: "too_large" };
        const mime = sniffImageType(bytes);
        if (!mime) return { kind: "failed", reason: "not_an_image" };
        return { kind: "ok", bytes, mime, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
        return { kind: "failed", reason: String(error).slice(0, 100) };
    } finally {
        cancelTimeout();
    }
}

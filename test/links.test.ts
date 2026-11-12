import { describe, expect, it } from "vitest";
import { classifyLink } from "../src/links/classify.ts";
import { findLinks } from "../src/links/find.ts";
import { vetLink } from "../src/links/hygiene.ts";

function classify(raw: string) {
    const vetted = vetLink(raw);
    return vetted.ok ? classifyLink(vetted.url, vetted.host) : undefined;
}

describe("findLinks", () => {
    it("finds links and where they sit", () => {
        expect(findLinks("看 https://example.com/a 这个")).toEqual([{ url: "https://example.com/a", start: 2, end: 23 }]);
    });

    it("ends a link at the first character a URL can't hold, as Chinese chat runs straight on", () => {
        expect(findLinks("https://b23.tv/abc123看看").map(({ url }) => url)).toEqual(["https://b23.tv/abc123"]);
        expect(findLinks("【标题】https://b23.tv/x1y2").map(({ url }) => url)).toEqual(["https://b23.tv/x1y2"]);
    });

    it("drops punctuation and unopened parentheses after a link, but keeps balanced ones", () => {
        expect(findLinks("see https://example.com/a.").map(({ url }) => url)).toEqual(["https://example.com/a"]);
        expect(findLinks("(https://example.com/a)").map(({ url }) => url)).toEqual(["https://example.com/a"]);
        expect(findLinks("https://en.wikipedia.org/wiki/Go_(game)!").map(({ url }) => url)).toEqual(["https://en.wikipedia.org/wiki/Go_(game)"]);
    });

    it("finds several links and ignores bare schemes", () => {
        expect(findLinks("https://a.com and http://b.org/x https://").map(({ url }) => url)).toEqual(["https://a.com", "http://b.org/x"]);
    });
});

describe("vetLink", () => {
    it.each([
        "ftp://example.com/a",
        "javascript:alert(1)",
        "https://user:pass@example.com/",
        "https://127.0.0.1/",
        "https://2130706433/",
        "https://0x7f.1/",
        "https://[::1]/",
        "https://localhost/",
        "https://intranet/",
        "https://printer.local/",
        "https://metadata.google.internal/",
        "https://example.com:8080/",
        `https://example.com/${"a".repeat(600)}`,
        "not a url",
    ])("refuses %s as unsafe", (raw) => {
        expect(vetLink(raw)).toEqual({ ok: false, reason: "unsafe_url" });
    });

    it.each([
        "https://discord.gg/abc",
        "https://t.me/+AbCdEf",
        "https://qm.qq.com/q/xyz",
        "https://news.example.com/unsubscribe?id=1",
        "https://example.com/account/reset-password",
        "https://example.com/oauth/authorize",
        "https://example.com/invite/abc",
    ])("refuses %s as an action", (raw) => {
        expect(vetLink(raw)).toEqual({ ok: false, reason: "action_link" });
    });

    it("lets article slugs that only mention an action through", () => {
        expect(vetLink("https://blog.example.com/posts/how-to-join-a-club").ok).toBe(true);
    });

    it("refuses document and file-sharing hosts, and the operator's own list", () => {
        expect(vetLink("https://docs.google.com/document/d/abc/edit")).toEqual({ ok: false, reason: "blocked_host" });
        expect(vetLink("https://www.dropbox.com/s/abc/file.pdf")).toEqual({ ok: false, reason: "blocked_host" });
        expect(vetLink("https://team.sharepoint.com/x")).toEqual({ ok: false, reason: "blocked_host" });
        expect(vetLink("https://forum.example.org/t/1", ["Example.org"])).toEqual({ ok: false, reason: "blocked_host" });
        expect(vetLink("https://notexample.org/t/1", ["example.org"]).ok).toBe(true);
    });

    it("strips the fragment and tracking parameters, and keeps the rest", () => {
        const vetted = vetLink("https://www.example.com/a?utm_source=x&id=3&fbclid=y&spm_id_from=z&si=q#top");
        expect(vetted).toMatchObject({ ok: true, host: "example.com", looksPrivate: false });
        expect(vetted.ok && vetted.url.href).toBe("https://www.example.com/a?id=3");
    });

    it("marks links that carry a key or a random token as private", () => {
        expect(vetLink("https://example.com/file?token=abc")).toMatchObject({ ok: true, looksPrivate: true });
        expect(vetLink("https://s3.example.com/f?X-Amz-Signature=abc")).toMatchObject({ ok: true, looksPrivate: true });
        expect(vetLink("https://example.com/share/aB3dE5gH7jK9mN1pQ3sT5v")).toMatchObject({ ok: true, looksPrivate: true });
        expect(vetLink("https://example.com/2026/11/a-perfectly-ordinary-article-title")).toMatchObject({ ok: true, looksPrivate: false });
    });
});

describe("classifyLink", () => {
    it.each([
        ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", { site: "youtube", id: "dQw4w9WgXcQ" }],
        ["https://youtu.be/dQw4w9WgXcQ?si=abc", { site: "youtube", id: "dQw4w9WgXcQ" }],
        ["https://m.youtube.com/shorts/dQw4w9WgXcQ", { site: "youtube", id: "dQw4w9WgXcQ" }],
        ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", { site: "youtube", id: "dQw4w9WgXcQ" }],
        ["https://x.com/someone/status/1234567890123456789", { site: "x", id: "1234567890123456789" }],
        ["https://twitter.com/i/web/status/42", { site: "x", id: "42" }],
        ["https://mobile.twitter.com/a/status/42/photo/1", { site: "x", id: "42" }],
        ["https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333", { site: "bilibili", id: "BV1xx411c7mD" }],
        ["https://m.bilibili.com/video/av170001", { site: "bilibili", id: "av170001" }],
        ["https://b23.tv/BV1xx411c7mD", { site: "bilibili", id: "BV1xx411c7mD" }],
        ["https://b23.tv/aBc123X", { site: "bilibili", id: "aBc123X", short: true }],
        ["https://github.com/nodejs/node/issues/1", { site: "github", id: "nodejs/node" }],
        ["https://github.com/biomejs/biome.git", { site: "github", id: "biomejs/biome" }],
    ])("recognises %s", (raw, expected) => {
        expect(classify(raw)).toEqual(expected);
    });

    it.each([
        "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
        "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/@channel",
        "https://x.com/someone",
        "https://x.com/someone/status/12ab",
        "https://bilibili.com.example/video/BV1xx411c7mD",
        "https://b23.tv/a/b",
        "https://github.com/settings/profile",
        "https://github.com/nodejs",
        "https://gist.github.com/a/b",
    ])("doesn't take %s for a known site", (raw) => {
        expect(classify(raw)).toBeUndefined();
    });
});

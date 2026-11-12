// biome-ignore-all lint/style/useNamingConvention: the sites' own field names

import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/lib/clock.ts";
import { classifyLink, type KnownLink } from "../src/links/classify.ts";
import { findLinks } from "../src/links/find.ts";
import { vetLink } from "../src/links/hygiene.ts";
import { htmlToText, readKnownSite, type SiteFetcher } from "../src/links/sites.ts";

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

describe("readKnownSite", () => {
    function fakeFetcher(answers: Record<string, unknown>, redirects: Record<string, string> = {}) {
        const requested: string[] = [];
        const fetcher: SiteFetcher = {
            json: async (url) => {
                requested.push(url);
                const host = new URL(url).hostname;
                if (!(host in answers)) throw new Error("HTTP 404");
                return answers[host];
            },
            redirect: async (url) => {
                requested.push(url);
                return redirects[url];
            },
        };
        return { fetcher, requested };
    }
    const read = (link: KnownLink, fetcher: SiteFetcher, options = {}) =>
        readKnownSite(link, fetcher, new ManualClock(), new AbortController().signal, options);

    it("reads a YouTube title and channel from oEmbed, built from the ID alone", async () => {
        const { fetcher, requested } = fakeFetcher({ "www.youtube.com": { title: "Never Gonna", author_name: "Rick" } });
        expect(await read({ site: "youtube", id: "dQw4w9WgXcQ" }, fetcher)).toEqual({ title: "Never Gonna", by: "Rick" });
        expect(requested).toEqual(["https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json"]);
    });

    it("adds the description through the Data API when there's a key", async () => {
        const { fetcher, requested } = fakeFetcher({
            "www.googleapis.com": { items: [{ snippet: { title: "T", channelTitle: "C", description: "long\n\ndesc" } }] },
        });
        expect(await read({ site: "youtube", id: "dQw4w9WgXcQ" }, fetcher, { youtubeApiKey: "k" })).toEqual({
            title: "T",
            by: "C",
            gist: "long desc",
        });
        expect(requested[0]).toBe("https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ&key=k");
    });

    it("reads a post's words from X's embed markup, without its links", async () => {
        const html =
            '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up &amp; <a href="https://t.co/x">https://t.co/x</a> pic.twitter.com/abc</p>&mdash; jack <a href="https://x.com/jack/status/20">March 21, 2006</a></blockquote>';
        const { fetcher, requested } = fakeFetcher({ "publish.x.com": { author_name: "jack", html } });
        expect(await read({ site: "x", id: "20" }, fetcher)).toEqual({ by: "jack", gist: "just setting up & (picture)" });
        expect(requested[0]).toBe("https://publish.x.com/oembed?url=https%3A%2F%2Ftwitter.com%2Fi%2Fstatus%2F20&omit_script=1&dnt=true");
    });

    it("reads Bilibili by BV or av number, and nothing when the API says no", async () => {
        const video = { code: 0, data: { title: "猫", owner: { name: "up主" }, desc: "简介" } };
        const { fetcher, requested } = fakeFetcher({ "api.bilibili.com": video });
        expect(await read({ site: "bilibili", id: "BV1xx411c7mD" }, fetcher)).toEqual({ title: "猫", by: "up主", gist: "简介" });
        await read({ site: "bilibili", id: "av170001" }, fetcher);
        expect(requested).toEqual([
            "https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD",
            "https://api.bilibili.com/x/web-interface/view?aid=170001",
        ]);
        const missing = fakeFetcher({ "api.bilibili.com": { code: -404 } });
        expect(await read({ site: "bilibili", id: "BV1xx411c7mD" }, missing.fetcher)).toBeUndefined();
    });

    it("follows a b23.tv code only to a Bilibili video", async () => {
        const video = { code: 0, data: { title: "猫" } };
        const good = fakeFetcher(
            { "api.bilibili.com": video },
            { "https://b23.tv/aBc123X": "https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy" },
        );
        expect(await read({ site: "bilibili", id: "aBc123X", short: true }, good.fetcher)).toEqual({ title: "猫" });
        expect(good.requested[1]).toBe("https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD");
        const elsewhere = fakeFetcher({ "api.bilibili.com": video }, { "https://b23.tv/aBc123X": "https://evil.example/video/BV1xx411c7mD" });
        expect(await read({ site: "bilibili", id: "aBc123X", short: true }, elsewhere.fetcher)).toBeUndefined();
        expect(elsewhere.requested).toEqual(["https://b23.tv/aBc123X"]);
    });

    it("reads a GitHub repository's description and language", async () => {
        const { fetcher } = fakeFetcher({
            "api.github.com": { full_name: "nodejs/node", description: "Node.js JavaScript runtime", language: "JavaScript" },
        });
        expect(await read({ site: "github", id: "nodejs/node" }, fetcher)).toEqual({
            title: "nodejs/node",
            gist: "Node.js JavaScript runtime (JavaScript)",
        });
    });

    it("gives up when the read takes too long", async () => {
        const clock = new ManualClock();
        const fetcher: SiteFetcher = {
            json: (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
            redirect: async () => undefined,
        };
        const pending = readKnownSite({ site: "github", id: "a/b" }, fetcher, clock, new AbortController().signal);
        const outcome = expect(pending).rejects.toThrow("aborted");
        await clock.advance(10_000);
        await outcome;
    });
});

describe("htmlToText", () => {
    it("drops tags and decodes entities", () => {
        expect(htmlToText("a<br>b &lt;i&gt; &#39;c&#x27; <b>d</b>")).toBe("a b <i> 'c' d");
    });
});

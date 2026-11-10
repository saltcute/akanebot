import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { People } from "../src/control/people.ts";
import { downloadImage, type ImageFetcher, isImageSource, MAX_IMAGE_BYTES, sniffImageType } from "../src/images/download.ts";
import { canUseHere } from "../src/images/offer.ts";
import { shrinkImage } from "../src/images/shrink.ts";
import { ManualClock } from "../src/lib/clock.ts";
import type { SavedImage } from "../src/memory/store.ts";
import { MemoryStore, type SavedImageDraft } from "../src/memory/store.ts";

function draft(overrides: Partial<SavedImageDraft> = {}): SavedImageDraft {
    return {
        sha256: "a",
        scope: "cli:group",
        messageId: "m1",
        userKey: "cli:alice",
        mime: "image/gif",
        bytes: Uint8Array.of(1, 2, 3),
        description: "一只瞪眼的猫",
        useFor: "无语",
        appeal: 0.8,
        embedding: undefined,
        embeddingModel: null,
        savedAt: 1000,
        ...overrides,
    };
}

describe("saved images in the store", () => {
    it("keeps the bytes but lists without them", () => {
        const store = new MemoryStore(":memory:");
        const id = store.saveImage(draft()) ?? 0;
        expect(store.savedImages()[0]).toMatchObject({ id, size: 3, description: "一只瞪眼的猫", timesSent: 0 });
        expect(store.savedImages()[0]).not.toHaveProperty("bytes");
        expect(store.savedImageContent(id)).toMatchObject({ mime: "image/gif" });
        expect([...(store.savedImageContent(id)?.bytes ?? [])]).toEqual([1, 2, 3]);
    });

    it("doesn't keep the same picture twice", () => {
        const store = new MemoryStore(":memory:");
        expect(store.saveImage(draft())).toBeDefined();
        expect(store.saveImage(draft({ messageId: "m2" }))).toBeUndefined();
        expect(store.savedImages()).toHaveLength(1);
    });

    it("goes when the person who posted it is forgotten, on any linked account", () => {
        const store = new MemoryStore(":memory:");
        const people = new People([{ name: "alice", ids: ["cli:alice", "discord:7"], aliases: [] }]);
        store.saveImage(draft());
        store.saveImage(draft({ sha256: "b", userKey: "discord:7" }));
        store.saveImage(draft({ sha256: "c", userKey: "cli:bob" }));
        expect(store.forgetImpact("cli:alice", people).images).toBe(2);
        store.forgetUser("cli:alice", people);
        expect(store.savedImages().map((image) => image.userKey)).toEqual(["cli:bob"]);
    });

    it("goes when the message it came from is deleted", () => {
        const store = new MemoryStore(":memory:");
        store.saveImage(draft());
        store.deleteLogged("cli:group", "m1");
        expect(store.savedImages()).toEqual([]);
    });

    it("over the limit, drops what she never used and likes least", () => {
        const store = new MemoryStore(":memory:");
        const used = store.saveImage(draft({ sha256: "used", appeal: 0.1 })) ?? 0;
        store.saveImage(draft({ sha256: "liked", appeal: 0.9 }));
        store.saveImage(draft({ sha256: "meh", appeal: 0.2 }));
        store.noteImageSent(used, 2000);
        expect(store.trimSavedImages(2)).toBe(1);
        expect(store.savedImages().map((image) => image.appeal)).toEqual([0.1, 0.9]);
    });
});

describe("where a picture can go", () => {
    const image = (overrides: Partial<SavedImage>) => ({ scope: "discord:a", link: null, ...overrides }) as SavedImage;
    const sharing = new Set(["discord:a", "discord:b", "qq:c"]);

    it("sends a saved file to any group sharing memories", () => {
        expect(canUseHere(image({}), "qq:c", sharing)).toBe(true);
    });

    it("keeps a GIF link off QQ, where it would be a bare URL", () => {
        const gif = image({ link: "https://tenor.com/view/a" });
        expect(canUseHere(gif, "discord:b", sharing)).toBe(true);
        expect(canUseHere(gif, "qq:c", sharing)).toBe(false);
    });
});

describe("downloading", () => {
    const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0);

    it.each([
        ["discord", "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1", true],
        ["discord", "https://evil.example/a.png", false],
        ["discord", "https://cdn.discordapp.com.evil.example/a.png", false],
        ["qq", "https://multimedia.nt.qq.com.cn/download?fileid=1", true],
        ["qq", "http://gchat.qpic.cn/gchatpic_new/1", true],
        ["qq", "http://127.0.0.1:6099/a.png", false],
        ["qq", "file:///etc/passwd", false],
        ["cli", "not a url", false],
        ["cli", "https://example.com/cat.png", true],
    ] as const)("%s %s allowed: %s", (platform, url, allowed) => {
        expect(isImageSource(platform, url)).toBe(allowed);
    });

    it("recognizes the formats it keeps from the file itself, and nothing else", () => {
        expect(sniffImageType(pngBytes)).toBe("image/png");
        expect(sniffImageType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
        expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
        expect(sniffImageType(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
        expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeUndefined();
    });

    it("never calls out to a host it doesn't expect", async () => {
        let called = false;
        const fetcher: ImageFetcher = async () => {
            called = true;
            return pngBytes;
        };
        await expect(downloadImage(fetcher, "discord", "https://evil.example/a.png", new ManualClock(0))).resolves.toMatchObject({
            kind: "failed",
            reason: "unexpected_host",
        });
        expect(called).toBe(false);
    });

    it("refuses an oversized file even from a fetcher that didn't stop", async () => {
        const fetcher: ImageFetcher = async () => new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0x89);
        await expect(downloadImage(fetcher, "cli", "https://x.test/a", new ManualClock(0))).resolves.toMatchObject({ reason: "too_large" });
    });

    it("gives up on a download that hangs", async () => {
        const clock = new ManualClock(0);
        const hanging: ImageFetcher = (_url, _max, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timed out"))));
        const download = downloadImage(hanging, "cli", "https://x.test/a", clock);
        await clock.advance(60_000);
        await expect(download).resolves.toMatchObject({ kind: "failed" });
    });
});

describe("shrinkImage", () => {
    const picture = (width: number, height: number) =>
        sharp({ create: { width, height, channels: 4, background: "#0af8" } })
            .png()
            .toBuffer();
    const sizeOf = async (data: string | undefined) => {
        const { width, height, format, hasAlpha } = await sharp(Buffer.from(data ?? "", "base64")).metadata();
        return { width, height, format, hasAlpha };
    };

    it("fits a large picture inside the limit, keeping its shape and transparency", async () => {
        const small = await shrinkImage(await picture(600, 1200), 300);
        expect(small?.mediaType).toBe("image/webp");
        expect(await sizeOf(small?.data)).toEqual({ width: 150, height: 300, format: "webp", hasAlpha: true });
    });

    it("never enlarges a small one", async () => {
        const small = await shrinkImage(await picture(40, 20), 300);
        expect(await sizeOf(small?.data)).toMatchObject({ width: 40, height: 20 });
    });

    it("gives up on bytes that aren't a picture", async () => {
        await expect(shrinkImage(Uint8Array.of(1, 2, 3), 300)).resolves.toBeUndefined();
    });
});

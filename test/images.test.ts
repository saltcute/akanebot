import { describe, expect, it } from "vitest";
import { People } from "../src/control/people.ts";
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

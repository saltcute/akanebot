import { describe, expect, it } from "vitest";
import { currentRelationship, updateRelationship } from "../src/body/relationships.ts";
import { NO_LINKS, People, peopleSchema } from "../src/control/people.ts";
import { ControlState, MemoryControlStore } from "../src/control/state.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { type MemoryDraft, MemoryStore } from "../src/memory/store.ts";

const PEOPLE = new People([{ name: "土豆", ids: ["qq:1", "discord:2"], note: "老朋友" }]);

function draft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
    return {
        scope: "qq:group",
        kind: "fact",
        subject: "qq:1",
        attributedTo: "qq:1",
        gist: "something",
        detail: "",
        importance: 0.5,
        salience: 0.1,
        confidence: 0.8,
        embedding: undefined,
        embeddingModel: null,
        sources: [{ messageId: "m1", speaker: "qq:1" }],
        createdAt: 0,
        ...overrides,
    };
}

describe("People", () => {
    it("treats every linked account as one person", () => {
        expect(PEOPLE.accountsOf("discord:2")).toEqual(["qq:1", "discord:2"]);
        expect(PEOPLE.personOf("discord:2")).toBe(PEOPLE.personOf("qq:1"));
        expect(PEOPLE.nameOf("discord:2")).toBe("土豆");
        expect(PEOPLE.noteOf("qq:1")).toBe("老朋友");
    });

    it("leaves an unlisted account as its own person", () => {
        expect(PEOPLE.accountsOf("qq:9")).toEqual(["qq:9"]);
        expect(PEOPLE.personOf("qq:9")).toBe("qq:9");
        expect(PEOPLE.nameOf("qq:9")).toBeUndefined();
    });

    it("rejects an account listed under two people", () => {
        const result = peopleSchema.safeParse([
            { name: "a", ids: ["qq:1"] },
            { name: "b", ids: ["qq:1"] },
        ]);
        expect(result.success).toBe(false);
    });

    it("rejects an ID without a platform", () => {
        expect(peopleSchema.safeParse([{ name: "a", ids: ["12345"] }]).success).toBe(false);
    });
});

describe("opting out with linked accounts", () => {
    const state = () => new ControlState({ clock: new ManualClock(), store: new MemoryControlStore(), people: PEOPLE });

    it("covers every account, whichever one opted out", () => {
        const control = state();
        control.optOut("discord:2");
        expect(control.isOptedOut("qq:1")).toBe(true);
        expect(control.isOptedOut("discord:2")).toBe(true);
    });

    it("is undone from any account", () => {
        const control = state();
        control.optOut("discord:2");
        control.optIn("qq:1");
        expect(control.isOptedOut("discord:2")).toBe(false);
    });
});

describe("forgetting a linked person", () => {
    it("removes what came from every account and what others said about any of their names", () => {
        const store = new MemoryStore(":memory:");
        store.addMemory(draft());
        store.addMemory(
            draft({ scope: "discord:g", subject: "discord:2", attributedTo: "discord:2", sources: [{ messageId: "m2", speaker: "discord:2" }] }),
        );
        store.addMemory(draft({ kind: "claim", subject: "name:土豆", attributedTo: "qq:7", sources: [{ messageId: "m3", speaker: "qq:7" }] }));
        const unrelated = store.addMemory(draft({ subject: "qq:7", attributedTo: "qq:7", sources: [{ messageId: "m4", speaker: "qq:7" }] }));
        expect(store.forgetImpact("discord:2", PEOPLE).memories).toBe(3);
        expect(store.forgetUser("discord:2", PEOPLE)).toBe(3);
        expect(store.all().map((memory) => memory.id)).toEqual([unrelated]);
    });

    it("clears relationships on every account", () => {
        const store = new MemoryStore(":memory:");
        updateRelationship(store, "qq:group", "qq:1", "friendly", true, 0, PEOPLE);
        updateRelationship(store, "discord:g", "discord:2", "friendly", true, 1, PEOPLE);
        store.forgetUser("qq:1", PEOPLE);
        expect(store.relationshipsOf(["qq:1", "discord:2"])).toEqual([]);
    });
});

describe("relationships across linked accounts", () => {
    it("carries from one platform to the other", () => {
        const store = new MemoryStore(":memory:");
        updateRelationship(store, "qq:group", "qq:1", "hostile", true, 0, PEOPLE);
        expect(currentRelationship(store, "discord:2", 0, PEOPLE).affinity).toBeCloseTo(-0.12);
    });

    it("stays separate without a link", () => {
        const store = new MemoryStore(":memory:");
        updateRelationship(store, "qq:group", "qq:1", "hostile", true, 0, NO_LINKS);
        expect(currentRelationship(store, "discord:2", 0, NO_LINKS).affinity).toBe(0);
    });

    it("keeps the highest familiarity when older rows disagree", () => {
        const store = new MemoryStore(":memory:");
        store.saveRelationship({ channel: "qq:group", userKey: "qq:1", familiarity: 0.8, affinity: 0, updatedAt: 0, gainDay: 0, dayGain: 0 });
        store.saveRelationship({ channel: "discord:g", userKey: "discord:2", familiarity: 0.2, affinity: 0, updatedAt: 5, gainDay: 0, dayGain: 0 });
        expect(currentRelationship(store, "discord:2", 5, PEOPLE).familiarity).toBe(0.8);
    });
});

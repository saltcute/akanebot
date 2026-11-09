import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/adapters/types.ts";
import type { Candidate } from "../src/body/actor.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { ChannelPerception } from "../src/perception/channel.ts";

function message(id: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        platform: "cli",
        channelId: "group",
        messageId: `m${id}`,
        sender: { id: "alice", displayName: "alice", isBot: false },
        text: "hi",
        sentAt: 0,
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: false,
        isBacklog: false,
        ...overrides,
    };
}

function setup(windowSize = 3) {
    const clock = new ManualClock();
    const offers: Candidate[] = [];
    const perception = new ChannelPerception({
        channel: "cli:group",
        clock,
        timing: { quietMs: 1000, maxWaitMs: 5000, candidateTtlMs: 60_000, windowSize },
        onReady: (candidate) => offers.push(candidate),
    });
    return { clock, offers, perception };
}

describe("ChannelPerception", () => {
    it("drops a forward that holds someone forgotten, and keeps the message", () => {
        const { perception } = setup();
        perception.ingest(message(1, { forwarded: [{ by: "bob", byUser: "cli:bob", text: "x" }] }));
        perception.ingest(message(2, { forwarded: [{ text: "y" }] }));
        perception.purgeQuotesBy("cli:bob");
        expect(perception.window().map(({ messageId, forwarded }) => [messageId, forwarded])).toEqual([
            ["m1", undefined],
            ["m2", [{ text: "y" }]],
        ]);
    });

    it("doesn't bring back a forward dropped while one of its pictures was being looked at", () => {
        const image = { url: "https://x/y.png" };
        const { perception } = setup();
        perception.ingest(message(1, { forwarded: [{ by: "bob", byUser: "cli:bob", text: "[image]", images: [image] }] }));
        perception.purgeQuotesBy("cli:bob");
        perception.describeForwardedImage("m1", image, "[image: 猫]");
        expect(perception.window()[0]?.forwarded).toBeUndefined();
    });

    it("drops a forward when someone forgotten is only in a forward inside it", () => {
        const { perception } = setup();
        perception.ingest(message(1, { forwarded: [{ text: "x", forwarded: [{ by: "bob", byUser: "cli:bob", text: "y" }] }] }));
        perception.purgeQuotesBy("cli:bob");
        expect(perception.window()[0]?.forwarded).toBeUndefined();
    });

    it("waits for quiet before offering", async () => {
        const { clock, offers, perception } = setup();
        perception.ingest(message(1));
        await clock.advance(999);
        expect(offers).toHaveLength(0);
        await clock.advance(1);
        expect(offers).toHaveLength(1);
    });

    it("restarts the quiet period on each message", async () => {
        const { clock, offers, perception } = setup();
        perception.ingest(message(1));
        await clock.advance(800);
        perception.ingest(message(2));
        await clock.advance(800);
        expect(offers).toHaveLength(0);
        await clock.advance(200);
        expect(offers).toHaveLength(1);
    });

    it("fires at maxWait even if the chat never goes quiet", async () => {
        const { clock, offers, perception } = setup();
        for (let i = 0; i < 12; i++) {
            perception.ingest(message(i));
            await clock.advance(500);
        }
        expect(offers.length).toBeGreaterThanOrEqual(1);
        expect(offers[0]?.expiresAt).toBe(5000 + 60_000);
    });

    it("raises priority when addressed, then resets", async () => {
        const { clock, offers, perception } = setup();
        perception.ingest(message(1, { mentionsSelf: true }));
        await clock.advance(1000);
        perception.ingest(message(2));
        await clock.advance(1000);
        expect(offers.map((offer) => offer.priority)).toEqual([10, 1]);
    });

    it("carries the sequence of the latest message", async () => {
        const { clock, offers, perception } = setup();
        perception.ingest(message(1));
        perception.ingest(message(2));
        await clock.advance(1000);
        expect(offers[0]?.snapshotSeq).toBe(2);
    });

    it("keeps only a rolling window", () => {
        const { perception } = setup(2);
        perception.ingest(message(1));
        perception.ingest(message(2));
        perception.ingest(message(3));
        expect(perception.window().map((m) => m.messageId)).toEqual(["m2", "m3"]);
    });

    it("does not offer for the agent's own message", async () => {
        const { clock, offers, perception } = setup();
        perception.recordOwn(message(1, { isSelf: true }));
        await clock.advance(10_000);
        expect(offers).toHaveLength(0);
        expect(perception.window()).toHaveLength(1);
    });

    it("skims a backlog down to the latest messages plus a few addressed ones", () => {
        const { perception } = setup(50);
        perception.ingest(message(1, { mentionsSelf: true }));
        perception.ingest(message(2, { mentionsSelf: true }));
        perception.ingest(message(3, { mentionsSelf: true }));
        for (let i = 4; i <= 20; i++) perception.ingest(message(i));
        expect(perception.skim(5, 2)).toBe(13);
        expect(perception.window().map((m) => m.messageId)).toEqual(["m2", "m3", "m16", "m17", "m18", "m19", "m20"]);
    });

    it("leaves a short backlog alone", () => {
        const { perception } = setup(50);
        perception.ingest(message(1));
        expect(perception.skim(5, 2)).toBe(0);
    });

    it("offers unread messages on return, prioritizing ones addressed to it", () => {
        const { perception } = setup(50);
        expect(perception.unreadCandidate()).toBeUndefined();
        perception.ingest(message(1, { repliesToSelf: true }));
        expect(perception.unreadCandidate()?.priority).toBe(10);
        perception.settle(perception.seq);
        expect(perception.unreadCandidate()).toBeUndefined();
    });
});

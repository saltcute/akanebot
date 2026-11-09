import { describe, expect, it } from "vitest";
import type { Adapter, ChatMessage } from "../src/adapters/types.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { DecisionTrace } from "../src/lib/trace.ts";
import { type GuardLimits, SendGuard } from "../src/reply/guards.ts";

const channel = { platform: "cli", channelId: "group" } as const;
const LIMITS: GuardLimits = { bucketCapacity: 3, refillPerMinute: 6, shareWindow: 10, maxShare: 0.4, minShareSample: 5 };

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        ...channel,
        messageId: id,
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

function fakeAdapter(send: () => Promise<{ messageId: string }>): Adapter & { sends: number } {
    const adapter = {
        platform: "cli" as const,
        sends: 0,
        start: async () => {},
        stop: async () => {},
        sendTyping: async () => {},
        send: async () => {
            adapter.sends++;
            return send();
        },
    };
    return adapter;
}

function setup(limits: Partial<GuardLimits> = {}) {
    const clock = new ManualClock();
    const trace = new DecisionTrace(clock);
    let next = 1;
    const adapter = fakeAdapter(async () => ({ messageId: `out${next++}` }));
    return { clock, trace, adapter, guard: new SendGuard({ clock, trace, limits: { ...LIMITS, ...limits } }) };
}

describe("SendGuard shadow channels", () => {
    const live = { platform: "cli", channelId: "live" } as const;

    function shadowSetup() {
        const clock = new ManualClock();
        const trace = new DecisionTrace(clock);
        const adapter = fakeAdapter(async () => ({ messageId: "out" }));
        return { trace, adapter, guard: new SendGuard({ clock, trace, limits: LIMITS, shadowChannels: new Set(["cli:group"]) }) };
    }

    it("holds back a shadow channel and delivers to any other", async () => {
        const { trace, adapter, guard } = shadowSetup();
        expect(await guard.send(adapter, channel, "hi")).toEqual({ kind: "blocked", reason: "shadow" });
        expect(adapter.sends).toBe(0);
        expect((await guard.send(adapter, live, "hi")).kind).toBe("sent");
        expect(adapter.sends).toBe(1);
        expect(trace.ofKind("send.shadow").map((event) => event.channel)).toEqual(["cli:group"]);
    });

    it("doesn't let a shadow channel use up a live channel's rate limit", async () => {
        const { adapter, guard } = shadowSetup();
        for (let i = 0; i < LIMITS.bucketCapacity + 1; i++) await guard.send(adapter, channel, "hi");
        expect((await guard.send(adapter, live, "hi")).kind).toBe("sent");
    });
});

describe("SendGuard.observe", () => {
    it("accepts a new message once and rejects redelivery", () => {
        const { guard } = setup();
        expect(guard.observe(message("a"))).toBe("new");
        expect(guard.observe(message("a"))).toBe("duplicate");
    });

    it("treats the same ID in another channel as a different message", () => {
        const { guard } = setup();
        guard.observe(message("a"));
        expect(guard.observe(message("a", { channelId: "other" }))).toBe("new");
    });

    it("filters messages flagged as its own", () => {
        const { guard } = setup();
        expect(guard.observe(message("a", { isSelf: true }))).toBe("self_echo");
    });

    it("filters an echo of something it sent even if the platform didn't flag it", async () => {
        const { guard, adapter } = setup();
        await guard.send(adapter, channel, "hello");
        expect(guard.observe(message("out1"))).toBe("self_echo");
    });

    it("never reacts to backlog, and backlog stays seen if redelivered live", () => {
        const { guard } = setup();
        expect(guard.observe(message("a", { isBacklog: true }))).toBe("backlog");
        expect(guard.observe(message("a"))).toBe("duplicate");
    });
});

describe("SendGuard.send", () => {
    it("sends and traces only what was actually sent", async () => {
        const { guard, adapter, trace } = setup();
        await expect(guard.send(adapter, channel, "hello")).resolves.toEqual({ kind: "sent", messageId: "out1" });
        expect(trace.ofKind("send.sent")).toHaveLength(1);
    });

    it("records who a send notifies", async () => {
        const { guard, adapter, trace } = setup();
        await guard.send(adapter, channel, "hi @bob", { mention: { userId: "42", start: 3, end: 7 } });
        expect(trace.ofKind("send.sent")[0]?.detail).toMatchObject({ text: "hi @bob", mention: "bob" });
    });

    it("never retries a failed send", async () => {
        const { clock, trace } = setup();
        const adapter = fakeAdapter(async () => {
            throw new Error("timeout");
        });
        const guard = new SendGuard({ clock, trace, limits: LIMITS });
        const outcome = await guard.send(adapter, channel, "hello");
        expect(outcome.kind).toBe("failed");
        expect(adapter.sends).toBe(1);
    });

    it("does not send once the lease is aborted", async () => {
        const { guard, adapter } = setup();
        const controller = new AbortController();
        controller.abort();
        await expect(guard.send(adapter, channel, "hello", { signal: controller.signal })).resolves.toEqual({ kind: "blocked", reason: "aborted" });
        expect(adapter.sends).toBe(0);
    });

    it("rate limits across channels and refills over time", async () => {
        const { guard, adapter, clock } = setup({ maxShare: 1 });
        for (let i = 0; i < 3; i++) await guard.send(adapter, { ...channel, channelId: `c${i}` }, "x");
        await expect(guard.send(adapter, channel, "x")).resolves.toEqual({ kind: "blocked", reason: "rate_limited" });
        await clock.advance(10_000);
        await expect(guard.send(adapter, channel, "x")).resolves.toMatchObject({ kind: "sent" });
    });

    it("stops talking to another bot once no human is around", async () => {
        const { guard, adapter } = setup({ bucketCapacity: 100, maxShare: 1 });
        for (let i = 0; i < 4; i++) {
            guard.observe(message(`b${i}`, { sender: { id: "bot", displayName: "bot", isBot: true } }));
            await guard.send(adapter, channel, "x");
        }
        await expect(guard.send(adapter, channel, "x")).resolves.toEqual({ kind: "blocked", reason: "bot_loop" });
        guard.observe(message("h1"));
        await expect(guard.send(adapter, channel, "x")).resolves.toMatchObject({ kind: "sent" });
    });

    it("sends urgent messages past every limit, exactly once", async () => {
        const { guard, adapter } = setup({ bucketCapacity: 0, maxShare: 0 });
        await expect(guard.sendUrgent(adapter, channel, "x")).resolves.toMatchObject({ kind: "sent" });
        expect(adapter.sends).toBe(1);
    });

    it("stops the agent dominating a channel", async () => {
        const { guard, adapter } = setup({ bucketCapacity: 100 });
        for (let i = 0; i < 3; i++) guard.observe(message(`in${i}`));
        for (let i = 0; i < 3; i++) await guard.send(adapter, channel, "x");
        await expect(guard.send(adapter, channel, "x")).resolves.toEqual({ kind: "blocked", reason: "share_breaker" });
    });

    describe("sendImage", () => {
        const image = { bytes: Uint8Array.of(1), mime: "image/png" };

        it("counts against the same limits as text", async () => {
            const { guard, adapter } = setup({ bucketCapacity: 1 });
            const withImages = { ...adapter, sendImage: async () => ({ messageId: "p1" }) };
            await expect(guard.sendImage(withImages, channel, image, "a cat")).resolves.toEqual({ kind: "sent", messageId: "p1" });
            await expect(guard.sendImage(withImages, channel, image, "a cat")).resolves.toMatchObject({ kind: "blocked", reason: "rate_limited" });
        });

        it("fails without trying on a platform that can't post pictures", async () => {
            const { guard, adapter } = setup();
            await expect(guard.sendImage(adapter, channel, image, "a cat")).resolves.toMatchObject({ kind: "failed" });
            expect(adapter.sends).toBe(0);
        });
    });

    it("does not trip the share breaker on a tiny sample", async () => {
        const { guard, adapter } = setup({ bucketCapacity: 100 });
        guard.observe(message("in1"));
        await guard.send(adapter, channel, "x");
        await expect(guard.send(adapter, channel, "x")).resolves.toMatchObject({ kind: "sent" });
    });

    it("recovers from the share breaker as others talk", async () => {
        const { guard, adapter } = setup({ bucketCapacity: 100 });
        for (let i = 0; i < 3; i++) guard.observe(message(`in${i}`));
        for (let i = 0; i < 3; i++) await guard.send(adapter, channel, "x");
        for (let i = 3; i < 10; i++) guard.observe(message(`in${i}`));
        await expect(guard.send(adapter, channel, "x")).resolves.toMatchObject({ kind: "sent" });
    });
});

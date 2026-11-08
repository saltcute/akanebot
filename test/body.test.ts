import { describe, expect, it } from "vitest";
import { type Attend, BodyActor, type BodyState, type Candidate, type Lease } from "../src/body/actor.ts";
import { ManualClock, sleep } from "../src/lib/clock.ts";
import { DecisionTrace } from "../src/lib/trace.ts";

function candidate(channel: string, priority = 1, expiresAt = 1_000_000): Candidate {
    return { channel, snapshotSeq: 1, priority, expiresAt };
}

function setup(attend: Attend) {
    const clock = new ManualClock();
    const trace = new DecisionTrace(clock);
    return { clock, trace, body: new BodyActor({ clock, trace, attend }) };
}

describe("BodyActor", () => {
    it("attends to one channel at a time", async () => {
        let active = 0;
        let maxActive = 0;
        const clock = new ManualClock();
        const body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (lease) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await sleep(clock, 100, lease.signal);
                active--;
            },
        });
        body.offer(candidate("a"));
        body.offer(candidate("b"));
        body.offer(candidate("c"));
        await clock.advance(1000);
        await body.whenIdle();
        expect(maxActive).toBe(1);
    });

    it("picks the highest priority first among offers from the same tick", async () => {
        const order: string[] = [];
        const { body } = setup(async (lease) => {
            order.push(lease.candidate.channel);
        });
        body.offer(candidate("low", 1));
        body.offer(candidate("high", 10));
        await body.whenIdle();
        expect(order).toEqual(["high", "low"]);
    });

    it("replaces a waiting candidate with a newer one from the same channel", async () => {
        const seqs: number[] = [];
        const { body } = setup(async (lease) => {
            seqs.push(lease.candidate.snapshotSeq);
        });
        body.offer({ ...candidate("a"), snapshotSeq: 1 });
        body.offer({ ...candidate("a"), snapshotSeq: 2 });
        await body.whenIdle();
        expect(seqs).toEqual([2]);
    });

    it("drops candidates that expired while waiting", async () => {
        const attended: string[] = [];
        const clock = new ManualClock();
        const trace = new DecisionTrace(clock);
        const body = new BodyActor({
            clock,
            trace,
            attend: async (lease) => {
                attended.push(lease.candidate.channel);
                await sleep(clock, 500, lease.signal);
            },
        });
        body.offer(candidate("first", 5));
        body.offer(candidate("stale", 1, 100));
        await clock.advance(1000);
        await body.whenIdle();
        expect(attended).toEqual(["first"]);
        expect(trace.ofKind("body.expired")).toHaveLength(1);
    });

    it("preempts for a much higher priority, then returns to the interrupted channel", async () => {
        const started: string[] = [];
        const clock = new ManualClock();
        const body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (lease) => {
                started.push(lease.candidate.channel);
                await sleep(clock, 100, lease.signal);
            },
        });
        body.offer(candidate("chatter", 1));
        await clock.advance(10);
        body.offer(candidate("urgent", 10));
        await clock.advance(1000);
        await body.whenIdle();
        expect(started).toEqual(["chatter", "urgent", "chatter"]);
    });

    it("is not preempted by a similar priority", async () => {
        const started: string[] = [];
        let aborted = false;
        const clock = new ManualClock();
        const body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (lease) => {
                started.push(lease.candidate.channel);
                aborted = !(await sleep(clock, 100, lease.signal)) || aborted;
            },
        });
        body.offer(candidate("a", 1));
        await clock.advance(10);
        body.offer(candidate("b", 2));
        await clock.advance(1000);
        await body.whenIdle();
        expect(aborted).toBe(false);
        expect(started).toEqual(["a", "b"]);
    });

    it("does not preempt while sending", async () => {
        let aborted = false;
        const clock = new ManualClock();
        const body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (lease) => {
                lease.setState("sending");
                aborted = !(await sleep(clock, 100, lease.signal)) || aborted;
            },
        });
        body.offer(candidate("a", 1));
        await clock.advance(10);
        body.offer(candidate("b", 50));
        await clock.advance(1000);
        await body.whenIdle();
        expect(aborted).toBe(false);
    });

    it("stops attending while away and resumes on return", async () => {
        const started: string[] = [];
        const { body } = setup(async (lease) => {
            started.push(lease.candidate.channel);
        });
        body.goAway();
        expect(body.state).toBe<BodyState>("away");
        body.offer(candidate("a"));
        await body.whenIdle();
        expect(started).toEqual([]);
        body.comeBack();
        await body.whenIdle();
        expect(started).toEqual(["a"]);
    });

    it("aborts the current lease when going away, even mid-send", async () => {
        let lease: Lease | undefined;
        const clock = new ManualClock();
        const body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (l) => {
                lease = l;
                l.setState("sending");
                await sleep(clock, 100, l.signal);
            },
        });
        body.offer(candidate("a"));
        await clock.advance(10);
        body.goAway();
        expect(lease?.signal.aborted).toBe(true);
    });

    it("survives a failing attend and keeps going", async () => {
        const started: string[] = [];
        const { body, trace } = setup(async (lease) => {
            started.push(lease.candidate.channel);
            if (lease.candidate.channel === "bad") throw new Error("boom");
        });
        body.offer(candidate("bad", 5));
        body.offer(candidate("good", 1));
        await body.whenIdle();
        expect(started).toEqual(["bad", "good"]);
        expect(trace.ofKind("body.attend_failed")).toHaveLength(1);
    });

    it("does not lose an offer made as the previous attend finishes", async () => {
        const started: string[] = [];
        let body: BodyActor | undefined;
        const clock = new ManualClock();
        body = new BodyActor({
            clock,
            trace: new DecisionTrace(clock),
            attend: async (lease) => {
                started.push(lease.candidate.channel);
                if (lease.candidate.channel === "a") body?.offer(candidate("b"));
            },
        });
        body.offer(candidate("a"));
        await body.whenIdle();
        expect(started).toEqual(["a", "b"]);
    });

    it("reports its state through the lease", async () => {
        const seen: BodyState[] = [];
        const { body } = setup(async (lease) => {
            seen.push(body.state);
            lease.setState("composing");
            seen.push(body.state);
            lease.setState("sending");
            seen.push(body.state);
        });
        body.offer(candidate("a"));
        await body.whenIdle();
        expect(seen).toEqual(["reading", "composing", "sending"]);
        expect(body.state).toBe<BodyState>("idle");
    });
});

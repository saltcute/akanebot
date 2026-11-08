import { describe, expect, it } from "vitest";
import { ManualClock, sleep } from "../src/lib/clock.ts";
import { Rng } from "../src/lib/rng.ts";
import { DecisionTrace } from "../src/lib/trace.ts";

describe("ManualClock", () => {
    it("fires timers in due order and only when advanced", async () => {
        const clock = new ManualClock();
        const fired: string[] = [];
        clock.setTimer(200, () => fired.push("b"));
        clock.setTimer(100, () => fired.push("a"));
        clock.setTimer(500, () => fired.push("c"));
        await clock.advance(250);
        expect(fired).toEqual(["a", "b"]);
        expect(clock.now()).toBe(250);
    });

    it("fires timers scheduled by other timers within the same advance", async () => {
        const clock = new ManualClock();
        const firedAt: number[] = [];
        clock.setTimer(10, () => clock.setTimer(10, () => firedAt.push(clock.now())));
        await clock.advance(100);
        expect(firedAt).toEqual([20]);
    });

    it("does not fire cancelled timers", async () => {
        const clock = new ManualClock();
        let fired = false;
        const cancel = clock.setTimer(10, () => {
            fired = true;
        });
        cancel();
        await clock.advance(100);
        expect(fired).toBe(false);
    });
});

describe("sleep", () => {
    it("resolves true when the delay passes", async () => {
        const clock = new ManualClock();
        const done = sleep(clock, 100);
        await clock.advance(100);
        await expect(done).resolves.toBe(true);
    });

    it("resolves false on abort, without waiting for the delay", async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        const done = sleep(clock, 100, controller.signal);
        controller.abort();
        await expect(done).resolves.toBe(false);
    });
});

describe("Rng", () => {
    it("is reproducible from a seed", () => {
        const a = new Rng("seed");
        const b = new Rng("seed");
        expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
    });

    it("differs across seeds", () => {
        expect(new Rng(1).next()).not.toBe(new Rng(2).next());
    });

    it("forks without shifting the parent stream", () => {
        const plain = new Rng("seed");
        const forked = new Rng("seed");
        forked.fork("gate").next();
        expect(forked.next()).toBe(plain.next());
    });

    it("gives independent streams to different fork labels", () => {
        const rng = new Rng("seed");
        expect(rng.fork("a").next()).not.toBe(rng.fork("b").next());
    });

    it("treats probabilities 0 and 1 as certain", () => {
        const rng = new Rng(3);
        for (let i = 0; i < 100; i++) {
            expect(rng.chance(0)).toBe(false);
            expect(rng.chance(1)).toBe(true);
        }
    });

    it("keeps int within inclusive bounds and reaches both ends", () => {
        const rng = new Rng(4);
        const seen = new Set<number>();
        for (let i = 0; i < 500; i++) seen.add(rng.int(1, 3));
        expect([...seen].sort()).toEqual([1, 2, 3]);
    });

    it("refuses to pick from nothing", () => {
        expect(() => new Rng(5).pick([])).toThrow();
    });
});

describe("DecisionTrace", () => {
    it("stamps events and looks them up by message", () => {
        const trace = new DecisionTrace(new ManualClock(42));
        trace.record("gate", { messageId: "m1" });
        trace.record("gate", { messageId: "m2" });
        expect(trace.forMessage("m1")).toEqual([{ at: 42, kind: "gate", messageId: "m1" }]);
    });

    it("drops the oldest events beyond its capacity", () => {
        const trace = new DecisionTrace(new ManualClock(), { capacity: 2 });
        trace.record("a");
        trace.record("b");
        trace.record("c");
        expect(trace.all().map((event) => event.kind)).toEqual(["b", "c"]);
    });
});

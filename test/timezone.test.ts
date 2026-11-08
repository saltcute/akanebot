import { describe, expect, it } from "vitest";
import { parsePersona } from "../src/persona/loader.ts";
import { renderReplyState } from "../src/reply/prompt.ts";
import { features, PERSONA } from "./fixtures.ts";

const TORONTO = { ...PERSONA, timezone: "America/Toronto" };

function localTime(now: number): string {
    return (
        renderReplyState({ now, persona: TORONTO, features: features(), competence: { mode: "casual", slip: false }, addressed: false }).split(
            "\n",
        )[0] ?? ""
    );
}

describe("time zones", () => {
    it("uses Eastern Daylight Time in summer", () => {
        expect(localTime(Date.UTC(2026, 6, 1, 16, 0))).toContain("12:00");
    });

    it("uses Eastern Standard Time in winter", () => {
        expect(localTime(Date.UTC(2026, 0, 15, 16, 0))).toContain("11:00");
    });

    it("switches on the actual daylight saving date", () => {
        // In 2026 clocks go back at 06:00 UTC on 1 November.
        expect(localTime(Date.UTC(2026, 10, 1, 5, 30))).toContain("01:30");
        expect(localTime(Date.UTC(2026, 10, 1, 6, 30))).toContain("01:30");
        expect(localTime(Date.UTC(2026, 10, 1, 7, 30))).toContain("02:30");
    });
});

describe("timezone override", () => {
    const source = `---
name: x
timezone: America/Toronto
schedule:
  sleep: { weekday: "01:30-08:40", weekend: "03:00-11:30" }
talkativeness: 0.3
stubbornness: 0.5
ignoreDirectAsks: 0.2
forgetfulness: 0.4
socialBattery: 60
maxCharsRead: 280
search: { curiosity: 0.3, dailyCap: 5 }
skills: { web: 4 }
slipRate: 0.25
maxCodeLines: 12
---
body`;

    it("keeps the persona's zone when no override is given", () => {
        expect(parsePersona(source).timezone).toBe("America/Toronto");
    });

    it("lets the override win", () => {
        expect(parsePersona(source, "p.md", "Europe/London").timezone).toBe("Europe/London");
    });

    it("names the env variable when the override is invalid", () => {
        expect(() => parsePersona(source, "p.md", "Mars/Olympus")).toThrow(/GABRIEL_TIMEZONE.*Mars\/Olympus/);
    });
});

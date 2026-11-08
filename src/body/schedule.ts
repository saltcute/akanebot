import type { Persona } from "../persona/schema.ts";

type LocalTime = { minutes: number; weekend: boolean; yesterdayWeekend: boolean; date: string };

export function localTime(now: number, timezone: string): LocalTime {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    const weekday = part("weekday");
    return {
        minutes: Number(part("hour")) * 60 + Number(part("minute")),
        weekend: weekday === "Sat" || weekday === "Sun",
        yesterdayWeekend: weekday === "Sun" || weekday === "Mon",
        date: `${part("year")}-${part("month")}-${part("day")}`,
    };
}

function parseRange(range: string): [number, number] {
    const [start, end] = range.split("-").map((time) => {
        const [hours, minutes] = time.split(":").map(Number);
        return (hours ?? 0) * 60 + (minutes ?? 0);
    });
    return [start ?? 0, end ?? 0];
}

/** A range may run past midnight, in which case its tail belongs to the previous day's schedule. */
export function isAsleep(persona: Pick<Persona, "schedule" | "timezone">, now: number): boolean {
    const { minutes, weekend, yesterdayWeekend } = localTime(now, persona.timezone);
    const { sleep } = persona.schedule;
    const [start, end] = parseRange(weekend ? sleep.weekend : sleep.weekday);
    if (start <= end ? minutes >= start && minutes < end : minutes >= start) return true;
    const [previousStart, previousEnd] = parseRange(yesterdayWeekend ? sleep.weekend : sleep.weekday);
    return previousStart > previousEnd && minutes < previousEnd;
}

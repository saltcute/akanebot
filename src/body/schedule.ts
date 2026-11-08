import type { Persona } from "../persona/schema.ts";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type LocalTime = { minutes: number; weekday: number; weekend: boolean; yesterdayWeekend: boolean; date: string };

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
        weekday: WEEKDAYS.indexOf(weekday.toLowerCase()),
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

/** Accepts "mon-fri", "sat,sun" or "wed". */
function matchesDays(days: string, weekday: number): boolean {
    return days.split(",").some((part) => {
        const [first, last] = part.trim().split("-");
        const start = WEEKDAYS.indexOf(first ?? "");
        const end = last === undefined ? start : WEEKDAYS.indexOf(last);
        return start <= end ? weekday >= start && weekday <= end : weekday >= start || weekday <= end;
    });
}

export function busyPeriod(persona: Pick<Persona, "schedule" | "timezone">, now: number): Persona["schedule"]["busy"][number] | undefined {
    const { minutes, weekday } = localTime(now, persona.timezone);
    return persona.schedule.busy.find((period) => {
        const [start, end] = parseRange(period.time);
        return matchesDays(period.days, weekday) && minutes >= start && minutes < end;
    });
}

export function hoursAround(persona: Pick<Persona, "schedule" | "timezone">, now: number): { minutesToSleep: number; minutesSinceWake: number } {
    const { minutes, weekend } = localTime(now, persona.timezone);
    const [start, end] = parseRange(weekend ? persona.schedule.sleep.weekend : persona.schedule.sleep.weekday);
    return { minutesToSleep: (start - minutes + 1440) % 1440, minutesSinceWake: (minutes - end + 1440) % 1440 };
}

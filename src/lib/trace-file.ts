import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "./trace.ts";

const DAY_MS = 86_400_000;
const FILE_PATTERN = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function fileFor(at: number): string {
    return `trace-${new Date(at).toISOString().slice(0, 10)}.jsonl`;
}

/** Decisions are written one file per UTC day, so old ones can simply be deleted. */
export function appendTraceEvent(directory: string, event: TraceEvent): void {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, fileFor(event.at)), `${JSON.stringify(event)}\n`);
}

export function deleteTracesBefore(directory: string, cutoff: number): void {
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch {
        return;
    }
    for (const name of names) {
        const date = FILE_PATTERN.exec(name)?.[1];
        if (date && Date.parse(date) + DAY_MS < cutoff) rmSync(join(directory, name));
    }
}

export function readTraceEvents(directory: string): TraceEvent[] {
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch {
        return [];
    }
    return names
        .filter((name) => FILE_PATTERN.test(name))
        .sort()
        .flatMap((name) =>
            readFileSync(join(directory, name), "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as TraceEvent),
        );
}

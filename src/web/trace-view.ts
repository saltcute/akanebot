import type { TraceEvent } from "../lib/trace.ts";

const GATE_DECISION_KEYS = ["speak", "probability", "addressed", "followUp", "possibleFollowUp", "mode", "slip", "battery", "addressOverruled"];
const GATE_FEATURE_KEYS = [
    "addressedToMe",
    "interest",
    "canFollow",
    "someoneAlreadyAnswered",
    "isTechnical",
    "difficulty",
    "highStakes",
    "towardMe",
    "safeToRepeat",
    "aboutPicture",
    "asksForPicture",
];
const RECALL_KEYS = ["id", "score", "detailed", "fromGroup"];

/**
 * What a bulk listing may show of each kind of event. Details can hold chat text, her private thoughts and quoted memories,
 * so anything not named here stays out, and a kind nobody has listed shows no detail at all.
 */
const SHOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
    alert: ["reason"],
    "body.attend": ["seq"],
    "body.offer": ["priority", "seq"],
    "body.preempt": ["by"],
    "body.skimmed": ["skipped"],
    "budget.exceeded": ["spentTodayUsd", "spentTotalUsd", "dailyBudgetUsd"],
    "control.web": ["action", "minutes", "memory", "image", "user", "level", "familiarity", "affinity"],
    "gate.repeat": ["repeat", "probability"],
    "image.judged": ["verdict", "appeal"],
    "image.declined": ["reason", "chance"],
    "image.offered": ["ids", "requested", "chance"],
    "image.saved": ["id", "mime", "size", "trimmed"],
    "image.skipped": ["reason"],
    "link.read": ["site", "layer"],
    "link.skipped": ["reason", "site"],
    "gate.silent": ["result"],
    "group_event.seen": ["kind"],
    "memory.consolidated": ["embedded", "merged", "promoted", "superseded", "archived"],
    "memory.extracted": ["written", "messages", "importance", "candidates"],
    "memory.forget_user": ["user", "removed"],
    "message.observed": ["observation"],
    "message.removed": ["logged"],
    "message.revised": ["edited"],
    "reaction.seen": ["noted", "removed"],
    "reply.abandoned": ["overtakenBy", "repeat"],
    "reply.pictures": ["shown", "result"],
    "reply.silent": ["result"],
    "routine.change": ["activity", "present"],
    "send.blocked": ["reason"],
};

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    const kept = keys.flatMap((key) => {
        const value = source[key];
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, value] as const] : [];
    });
    return Object.fromEntries(kept);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function shownDetail(kind: string, detail: Record<string, unknown>): Record<string, unknown> {
    if (kind === "gate.decision") {
        return { ...pick(detail, GATE_DECISION_KEYS), ...(isRecord(detail.features) ? pick(detail.features, GATE_FEATURE_KEYS) : {}) };
    }
    if (kind === "memory.recall") {
        return { recalled: Array.isArray(detail.recalled) ? detail.recalled.filter(isRecord).map((entry) => pick(entry, RECALL_KEYS)) : [] };
    }
    return pick(detail, SHOWN_KEYS[kind] ?? []);
}

/** An event reduced to what's safe in a list. The whole thing stays available one message at a time, through its decisions. */
export function presentTraceEvent(event: TraceEvent): TraceEvent {
    const { detail, ...rest } = event;
    return detail ? { ...rest, detail: shownDetail(event.kind, detail) } : rest;
}

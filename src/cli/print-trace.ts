import type { TraceEvent } from "../lib/trace.ts";

const PLAIN_KINDS = new Set([
    "alert",
    "control.crisis",
    "control.crisis_hold",
    "control.not_allowed",
    "control.opted_out",
    "gate.silent",
    "reply.silent",
    "reply.chose_silence",
    "reply.code_too_long",
    "budget.exceeded",
    "send.blocked",
    "send.failed",
    "body.attend_failed",
]);

/** One readable console line for the decisions worth watching live. */
export function printTraceEvent(event: TraceEvent): void {
    const detail = event.detail ?? {};
    if (event.kind === "memory.recall") {
        const recalled = detail.recalled as { gist: string; score: number; detailed: boolean }[];
        for (const item of recalled) console.log(`  [recall ${item.score.toFixed(2)}${item.detailed ? "" : " gist only"}] ${item.gist}`);
    } else if (event.kind === "memory.extracted") {
        console.log(`  [memory] wrote ${detail.written} from ${detail.messages} messages`);
    } else if (event.kind === "send.shadow") {
        console.log(`  [would say] ${detail.text}`);
    } else if (event.kind === "gate.decision") {
        const features = detail.features as { topic: string; interest: number; difficulty: number; domain: string; privateThought: string };
        const chance = `${Math.round((detail.probability as number) * 100)}%`;
        console.log(
            `  [gate ${event.messageId}] ${detail.speak ? "SPEAK" : "stay quiet"} (chance ${chance}, ${detail.addressed ? "addressed" : "not addressed"}) ` +
                `topic="${features.topic}" interest=${features.interest} mode=${detail.mode}${detail.slip ? "+slip" : ""} ` +
                `${features.domain}/${features.difficulty} thought="${features.privateThought}"`,
        );
    } else if (PLAIN_KINDS.has(event.kind)) {
        console.log(`  [${event.kind}] ${JSON.stringify(detail)}`);
    }
}

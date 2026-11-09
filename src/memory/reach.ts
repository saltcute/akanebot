import type { Memory, MemoryKind, MemoryReach } from "./store.ts";

export type SuggestedReach = "general" | "group";

/** Anyone asking for discretion anywhere in a conversation keeps all of that conversation in the group. */
const SECRECY_PATTERN =
    /别(说出去|外传|传出去|告诉(别人|其他人|他|她|他们))|不要(说出去|外传|传出去|告诉(别人|其他人|他|她|他们))|保密|只(跟|和|对)你说|\b(don'?t tell (anyone|anybody|others|them)|keep (this|it) (a )?secret|between us|off the record|confidential)\b/i;

/**
 * What may ever leave its group, however it was classified.
 * Summaries of a conversation, attempts to instruct her, and anything one person said about another or about her all stay put,
 * which also stops one group from rewriting who she is everywhere else.
 */
export function isShareable({ kind, subject }: { kind: MemoryKind; subject: string | null }): boolean {
    if (kind === "episode" || kind === "event") return false;
    if (kind === "claim") return subject === "group";
    return subject !== null;
}

/** The model only suggests, and code can only narrow what it suggests. */
export function decideReach(
    memory: { kind: MemoryKind; subject: string | null },
    suggested: SuggestedReach,
    options: { groupShares: boolean; conversation: string },
): MemoryReach {
    const allowed = options.groupShares && suggested === "general" && isShareable(memory) && !SECRECY_PATTERN.test(options.conversation);
    return allowed ? "shared" : "group";
}

/**
 * Whether a memory from another group may come to mind right now. Someone's own news only surfaces while they are the one talking,
 * so nobody can fish for what an absent person said elsewhere.
 */
export function canCrossGroups(memory: Memory, speakers: readonly string[]): boolean {
    if (memory.reach !== "shared" || !isShareable(memory)) return false;
    return memory.subject === "self" || memory.subject === "group" || speakers.includes(memory.subject ?? "");
}

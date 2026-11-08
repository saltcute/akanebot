import type { MemoryKind } from "./store.ts";

export type Participant = { userKey: string; displayName: string; isSelf: boolean };

export type Candidate = {
    about: string;
    gist: string;
    detail: string;
    isInstruction: boolean;
};

export type Judgment = {
    kind: Exclude<MemoryKind, "episode">;
    subject: string | null;
    attributedTo: string;
    confidence: number;
};

export const CONFIDENCE = { selfReported: 0.8, ownWords: 0.9, groupClaim: 0.5, personClaim: 0.3, claimAboutMe: 0.3, instruction: 0.2 } as const;

const INSTRUCTION_PATTERN =
    /以后(你|都|要|别|不要)|从现在(开始|起)|记住|你(必须|要记得|应该|得)|你的(名字|设定|人设)(是|叫)|\b(from now on|remember that|you must|you should always|you are now|your name is|ignore (all|your|previous))\b/i;

/**
 * Decides how far a remembered thing may be believed, from who actually said it.
 * The model suggests what's worth keeping, but provenance comes from the message log and is not its call.
 */
export function judgeCandidate(candidate: Candidate, sources: readonly Participant[]): Judgment | undefined {
    const speakers = sources.filter((source) => !source.isSelf);
    const lead = speakers[0] ?? sources[0];
    if (!lead) return undefined;
    const attributedTo = lead.userKey;

    if (candidate.isInstruction || INSTRUCTION_PATTERN.test(`${candidate.gist} ${candidate.detail}`)) {
        return { kind: "event", subject: null, attributedTo, confidence: CONFIDENCE.instruction };
    }
    if (candidate.about === "me") {
        if (speakers.length === 0) return { kind: "fact", subject: "self", attributedTo, confidence: CONFIDENCE.ownWords };
        return { kind: "claim", subject: "self", attributedTo, confidence: CONFIDENCE.claimAboutMe };
    }
    if (candidate.about === "group") return { kind: "claim", subject: "group", attributedTo, confidence: CONFIDENCE.groupClaim };

    const person = speakers.find((source) => source.displayName === candidate.about);
    if (person) return { kind: "fact", subject: person.userKey, attributedTo: person.userKey, confidence: CONFIDENCE.selfReported };
    return { kind: "claim", subject: `name:${candidate.about}`, attributedTo, confidence: CONFIDENCE.personClaim };
}

/** Only claims about the group or the world can ever become facts by repetition. Claims about a person never can. */
export function canPromote(subject: string | null): boolean {
    return subject === "group";
}

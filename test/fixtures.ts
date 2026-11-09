import type { GateFeatures } from "../src/gate/features.ts";
import type { Persona } from "../src/persona/schema.ts";

export const PERSONA: Persona = {
    name: "小茜",
    aliases: ["akane"],
    timezone: "Asia/Shanghai",
    schedule: { sleep: { weekday: "01:30-08:40", weekend: "03:00-11:30" }, busy: [] },
    talkativeness: 0.35,
    stubbornness: 0.7,
    ignoreDirectAsks: 0.2,
    forgetfulness: 0.4,
    socialBattery: 60,
    maxCharsRead: 280,
    search: { curiosity: 0.3, dailyCap: 5 },
    skills: { dataStructures: 3, web: 4, mathProofs: 2 },
    slipRate: 0.25,
    maxCodeLines: 12,
    lowEffort: 0,
    reactions: { discord: ["👍", "😭"], qq: { thumbs: 76, "👍": 128077 } },
    dailyLife: [],
    prose: "# Who I am\n小茜",
};

export function features(overrides: Partial<GateFeatures> = {}): GateFeatures {
    return {
        addressedToMe: "no",
        topic: "chat",
        interest: 0.5,
        canFollow: true,
        someoneAlreadyAnswered: false,
        isTechnical: false,
        domain: "other",
        difficulty: 1,
        highStakes: false,
        towardMe: "neutral",
        lookUp: "",
        quickReaction: "",
        privateThought: "嗯",
        ...overrides,
    };
}

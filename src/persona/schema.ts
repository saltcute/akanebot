import { z } from "zod";
import type { Platform } from "../adapters/types.ts";

const unit = z.number().min(0).max(1);
const timeRange = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Expected a time range like "01:30-08:40"');

export function isTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

export const personaSettingsSchema = z.strictObject({
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    timezone: z.string().refine(isTimeZone, "Unknown time zone"),
    schedule: z.strictObject({
        sleep: z.strictObject({ weekday: timeRange, weekend: timeRange }),
        busy: z
            .array(
                z.strictObject({
                    days: z
                        .string()
                        .regex(
                            /^(sun|mon|tue|wed|thu|fri|sat)(-(sun|mon|tue|wed|thu|fri|sat))?(,(sun|mon|tue|wed|thu|fri|sat)(-(sun|mon|tue|wed|thu|fri|sat))?)*$/,
                            'Expected days like "mon-fri" or "sat,sun"',
                        ),
                    time: timeRange,
                    checkPhoneEveryMin: z.tuple([z.number().positive(), z.number().positive()]),
                    mentionUrgency: unit.default(0),
                }),
            )
            .default([]),
    }),
    talkativeness: unit,
    stubbornness: unit,
    ignoreDirectAsks: unit,
    forgetfulness: unit,
    socialBattery: z.number().int().positive(),
    maxCharsRead: z.number().int().positive(),
    search: z.strictObject({ curiosity: unit, dailyCap: z.number().int().min(0) }),
    skills: z.record(z.string(), z.number().int().min(1).max(5)),
    slipRate: unit,
    lowEffort: unit.default(0),
    repeatRate: unit.default(0),
    reactions: z
        .strictObject({
            discord: z.array(z.string().min(1)).default([]),
            qq: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
        })
        .default({ discord: [], qq: {} }),
    dailyLife: z.array(z.string().min(1)).default([]),
    maxCodeLines: z.number().int().positive(),
});

export type PersonaSettings = z.infer<typeof personaSettingsSchema>;
export type Persona = PersonaSettings & { prose: string };

/** `label` is how the agent knows the reaction, `id` is what the platform is sent. */
export type ReactionChoice = { label: string; id: string };

/** The simulator has no reaction limits of its own, so it shares Discord's list. */
export function reactionChoices(persona: Persona, platform: Platform): ReactionChoice[] {
    if (platform === "qq") return Object.entries(persona.reactions.qq).map(([label, id]) => ({ label, id: String(id) }));
    return persona.reactions.discord.map((emoji) => ({ label: emoji, id: emoji }));
}

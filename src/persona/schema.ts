import { z } from "zod";

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
    dailyLife: z.array(z.string().min(1)).default([]),
    maxCodeLines: z.number().int().positive(),
});

export type PersonaSettings = z.infer<typeof personaSettingsSchema>;
export type Persona = PersonaSettings & { prose: string };

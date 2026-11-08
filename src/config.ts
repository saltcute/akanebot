import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { pricesSchema } from "./lib/cost.ts";
import { embedderConfigSchema } from "./llm/embedder.ts";
import { llmConfigSchema } from "./llm/registry.ts";

export const appConfigSchema = z.strictObject({
    ...llmConfigSchema.shape,
    prices: pricesSchema,
    persona: z.string().min(1),
    embedder: embedderConfigSchema,
    memory: z.strictObject({
        path: z.string().min(1).default("data/memory.db"),
        /** A conversation counts as over after this many minutes without anything attended. */
        segmentGapMinutes: z.number().positive().default(20),
        maxSegmentMessages: z.number().int().positive().default(60),
        rawRetentionDays: z.number().positive().default(30),
        dailyWritesPerUser: z.number().int().positive().default(30),
    }),
    control: z.strictObject({
        commandPrefix: z.string().min(1).default("/gabriel"),
        /** `platform:userId` of each person allowed to run admin commands. */
        admins: z.array(z.string().min(1)).default([]),
        /** The agent acts only in groups listed here with `disclosed: true`. */
        groups: z
            .array(z.strictObject({ platform: z.enum(["discord", "qq", "cli"]), channelId: z.string().min(1), disclosed: z.boolean() }))
            .default([]),
        crisisResources: z.string().min(1),
        statePath: z.string().min(1).default("data/control.json"),
    }),
    dailyBudgetUsd: z.number().positive(),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** `config.yaml` is the maintainer's own copy. Without one, the tracked example applies. */
export function loadConfig(path?: string): { config: AppConfig; path: string } {
    const resolved = path ?? (existsSync("config.yaml") ? "config.yaml" : "config.example.yaml");
    const parsed = appConfigSchema.safeParse(parse(readFileSync(resolved, "utf8")));
    if (!parsed.success) throw new Error(`Invalid config in ${resolved}:\n${z.prettifyError(parsed.error)}`);
    return { config: parsed.data, path: resolved };
}

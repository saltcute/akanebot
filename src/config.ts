import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { pricesSchema } from "./lib/cost.ts";
import { embedderConfigSchema } from "./llm/embedder.ts";
import { llmConfigSchema } from "./llm/registry.ts";
import { searchConfigSchema } from "./llm/search.ts";
import { pacingSchema } from "./reply/timing.ts";

export const appConfigSchema = z.strictObject({
    ...llmConfigSchema.shape,
    prices: pricesSchema,
    persona: z.string().min(1),
    /** Reads and decides, but never posts anything. */
    shadow: z.boolean().default(true),
    timing: z
        .strictObject({
            quietMs: z.number().positive().default(3000),
            maxWaitMs: z.number().positive().default(15_000),
            candidateTtlMs: z.number().positive().default(180_000),
            windowSize: z.number().int().positive().default(40),
        })
        .prefault({}),
    pacing: pacingSchema.prefault({}),
    limits: z
        .strictObject({
            bucketCapacity: z.number().positive().default(10),
            refillPerMinute: z.number().positive().default(6),
            shareWindow: z.number().int().positive().default(20),
            maxShare: z.number().min(0).max(1).default(0.4),
            minShareSample: z.number().int().positive().default(5),
        })
        .prefault({}),
    embedder: embedderConfigSchema,
    search: searchConfigSchema,
    memory: z.strictObject({
        path: z.string().min(1).default("data/memory.db"),
        /** A conversation counts as over after this many minutes without anything attended. */
        segmentGapMinutes: z.number().positive().default(20),
        maxSegmentMessages: z.number().int().positive().default(60),
        rawRetentionDays: z.number().positive().default(30),
        dailyWritesPerUser: z.number().int().positive().default(30),
    }),
    control: z.strictObject({
        commandPrefix: z.string().min(1).default("/akanebot"),
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
    /** A OneBot 11 server such as NapCat, needed for any `qq` group. Its access token, if any, comes from ONEBOT_TOKEN. */
    qq: z.strictObject({ url: z.string().min(1) }).optional(),
    /** The operator's web UI. The login token comes from AKANEBOT_WEB_TOKEN, or is generated at startup. */
    web: z
        .strictObject({
            enabled: z.boolean().default(true),
            host: z.string().min(1).default("127.0.0.1"),
            port: z.number().int().min(0).max(65_535).default(8787),
        })
        .prefault({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** `config.yaml` is the maintainer's own copy. Without one, the tracked example applies. */
export function loadConfig(path?: string): { config: AppConfig; path: string } {
    const resolved = path ?? process.env.AKANEBOT_CONFIG ?? (existsSync("config.yaml") ? "config.yaml" : "config.example.yaml");
    const parsed = appConfigSchema.safeParse(parse(readFileSync(resolved, "utf8")));
    if (!parsed.success) throw new Error(`Invalid config in ${resolved}:\n${z.prettifyError(parsed.error)}`);
    return { config: parsed.data, path: resolved };
}

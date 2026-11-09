import { DiscordAdapter } from "./adapters/discord.ts";
import { OneBotAdapter } from "./adapters/onebot.ts";
import type { Adapter } from "./adapters/types.ts";
import { printTraceEvent } from "./cli/print-trace.ts";
import { loadConfig } from "./config.ts";
import { People } from "./control/people.ts";
import { JsonFileControlStore } from "./control/state.ts";
import { SystemClock } from "./lib/clock.ts";
import { CostMeter } from "./lib/cost.ts";
import { Rng } from "./lib/rng.ts";
import { DecisionTrace } from "./lib/trace.ts";
import { appendTraceEvent, deleteTracesBefore } from "./lib/trace-file.ts";
import { createEmbedder } from "./llm/embedder.ts";
import { BACKEND_FACTORIES, createSearchBackend } from "./llm/factories.ts";
import { LlmRegistry } from "./llm/registry.ts";
import { TRACE_DIRECTORY } from "./main-settings.ts";
import { MemoryStore } from "./memory/store.ts";
import { loadPersona } from "./persona/loader.ts";
import { watchPersona } from "./persona/watch.ts";
import { Runtime } from "./runtime.ts";
import { createConfigView } from "./web/config-view.ts";
import { startWebConsole } from "./web/start.ts";

const DAY_MS = 86_400_000;

function fail(message: string): never {
    console.error(`\n${message}\n`);
    process.exit(1);
}

const { config, path: configPath } = loadConfig();
const timezoneOverride = process.env.AKANEBOT_TIMEZONE || undefined;
const persona = loadPersona(config.persona, timezoneOverride);

if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is empty. Add it to .env.");

const placeholder = /REPLACE_WITH/;
const groups = config.control.groups.filter((group) => group.disclosed && !placeholder.test(group.channelId));
if (groups.length === 0) fail(`No groups to join. Put a real channel or group ID under control.groups in ${configPath}.`);
const admins = config.control.admins.filter((admin) => !placeholder.test(admin));

const clock = new SystemClock();
deleteTracesBefore(TRACE_DIRECTORY, clock.now() - config.memory.rawRetentionDays * DAY_MS);
const trace = new DecisionTrace(clock, {
    sink: (event) => {
        appendTraceEvent(TRACE_DIRECTORY, event);
        printTraceEvent(event);
    },
});
const memoryStore = new MemoryStore(config.memory.path);
const cost = new CostMeter({ clock, prices: config.prices, dailyBudgetUsd: config.dailyBudgetUsd, store: memoryStore });
const llm = new LlmRegistry({ backends: config.backends, roles: config.roles }, BACKEND_FACTORIES, (usage, _role, model) => cost.add(usage, model));
const reportStatus = (platform: string) => (status: string, detail?: string) =>
    trace.record("alert", { detail: { reason: `${platform}_${status}`, ...(detail ? { detail } : {}) } });

const adapters: Adapter[] = [];
let discord: DiscordAdapter | undefined;
if (groups.some((group) => group.platform === "discord")) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) fail("DISCORD_TOKEN is empty. Add your bot token to .env.");
    discord = new DiscordAdapter({ token, onStatus: reportStatus("discord") });
    adapters.push(discord);
}
if (groups.some((group) => group.platform === "qq")) {
    if (!config.qq) fail(`A QQ group is listed, but ${configPath} has no qq.url for the OneBot server.`);
    adapters.push(
        new OneBotAdapter({
            url: config.qq.url,
            token: process.env.ONEBOT_TOKEN || undefined,
            clock,
            selfName: persona.name,
            onStatus: reportStatus("qq"),
        }),
    );
}

const runtime = new Runtime({
    clock,
    rng: new Rng(clock.now()),
    trace,
    llm,
    cost,
    persona,
    adapters,
    timing: config.timing,
    limits: config.limits,
    control: { commandPrefix: config.control.commandPrefix, admins, groups },
    controlStore: new JsonFileControlStore(config.control.statePath),
    memoryStore,
    embedder: createEmbedder(config.embedder, (message) => trace.record("alert", { detail: { reason: "embedder_failed", message } })),
    people: new People(config.people),
    memorySettings: {
        segmentGapMs: config.memory.segmentGapMinutes * 60_000,
        maxSegmentMessages: config.memory.maxSegmentMessages,
        rawRetentionMs: config.memory.rawRetentionDays * DAY_MS,
        dailyWritesPerUser: config.memory.dailyWritesPerUser,
    },
    shadow: config.shadow,
    pacing: config.pacing,
    routine: true,
    search: createSearchBackend(config.search, (usage, model) => cost.add(usage, model)),
});

const stopWatching = watchPersona({
    path: config.persona,
    ...(timezoneOverride ? { timezoneOverride } : {}),
    clock,
    onReload: (updated) => {
        runtime.setPersona(updated);
        console.log(`  [persona] reloaded ${config.persona}`);
    },
    onError: (message) => console.log(`  [persona] kept the previous version, the file has a problem:\n${message}`),
});

try {
    await runtime.start();
} catch (error) {
    const message = String(error);
    if (/disallowed intent/i.test(message)) {
        fail("Discord refused the connection: turn on MESSAGE CONTENT INTENT under Bot > Privileged Gateway Intents in the Developer Portal.");
    }
    if (/invalid token|TokenInvalid/i.test(message)) fail("Discord rejected the token. Check DISCORD_TOKEN in .env (Bot > Reset Token).");
    fail(`Couldn't start: ${message}`);
}

console.log(`${persona.name} is online${discord ? ` as ${discord.botTag} on Discord` : ""} (config: ${configPath})`);
console.log(`Watching ${groups.length} channel(s). Mode: ${config.shadow ? "SHADOW, she decides but sends nothing" : "LIVE, she will post"}.`);
if (admins.length === 0) console.log(`No admins set, so ${config.control.commandPrefix} kill and mute won't work for anyone.`);

const webConsole = await startWebConsole(
    config.web,
    runtime,
    process.env.AKANEBOT_WEB_TOKEN,
    (message) => trace.record("alert", { detail: { reason: "web_failed", message } }),
    createConfigView(config, configPath),
);

let stopping = false;
async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down...");
    stopWatching();
    await webConsole?.stop();
    await runtime.stop();
    console.log(cost.summary());
    process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

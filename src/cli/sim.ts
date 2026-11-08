import { createInterface } from "node:readline/promises";
import { CliAdapter } from "../adapters/cli.ts";
import { loadConfig } from "../config.ts";
import { MemoryControlStore } from "../control/state.ts";
import { SystemClock } from "../lib/clock.ts";
import { CostMeter } from "../lib/cost.ts";
import { Rng } from "../lib/rng.ts";
import { DecisionTrace } from "../lib/trace.ts";
import { createEmbedder, NullEmbedder } from "../llm/embedder.ts";
import { BACKEND_FACTORIES, createSearchBackend } from "../llm/factories.ts";
import { FakeBackend } from "../llm/fake.ts";
import { type BackendFactory, LlmRegistry, llmConfigSchema } from "../llm/registry.ts";
import { MemoryStore } from "../memory/store.ts";
import { loadPersona } from "../persona/loader.ts";
import { watchPersona } from "../persona/watch.ts";
import { Runtime } from "../runtime.ts";
import { printTraceEvent } from "./print-trace.ts";

const SIM_DATABASE = "data/sim-memory.db";
const CANNED_REPLIES = ["哈哈", "真的假的", "不知道诶", "lol", "等下 我看看"];
const CANNED_GATE = JSON.stringify({
    addressedToMe: "yes",
    topic: "whatever",
    interest: 0.5,
    someoneAlreadyAnswered: false,
    isTechnical: false,
    domain: "other",
    difficulty: 1,
    highStakes: false,
    possibleCrisis: false,
    towardMe: "neutral",
    lookUp: "",
    quickReaction: "",
    privateThought: "(fake backend)",
});

const useFake = process.argv.includes("--fake");
const { config, path: configPath } = loadConfig();
const timezoneOverride = process.env.GABRIEL_TIMEZONE || undefined;
const persona = loadPersona(config.persona, timezoneOverride);

if (!useFake && !process.env.ANTHROPIC_API_KEY && Object.values(config.backends).some((backend) => backend.type === "anthropic")) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env, or run `pnpm sim --fake` for canned replies.");
    process.exit(1);
}

const clock = new SystemClock();
const rng = new Rng(clock.now());
let verbose = true;
const trace = new DecisionTrace(clock, { sink: (event) => verbose && printTraceEvent(event) });
const cost = new CostMeter({ clock, prices: config.prices, dailyBudgetUsd: config.dailyBudgetUsd });
const adapter = new CliAdapter({
    clock,
    selfName: persona.name,
    aliases: persona.aliases,
    print: (line) => console.log(line),
    idPrefix: `${clock.now().toString(36)}-`,
});

const fakeFactory: BackendFactory = (_config, model) =>
    new FakeBackend((request) => {
        if (model === "scripted-crisis") return "(fake crisis response)";
        if (model === "scripted-vision") return "(a picture)";
        if (model === "scripted-extract") return JSON.stringify({ summary: "", importance: 0, emotion: 0, memories: [] });
        if (model === "scripted-consolidate") return JSON.stringify({ replaced: [] });
        if (model !== "scripted-gate") return JSON.stringify({ messages: [rng.pick(CANNED_REPLIES)] });
        return request.stable.startsWith("Decide whether") ? JSON.stringify({ isCrisis: true }) : CANNED_GATE;
    });
const llm = useFake
    ? new LlmRegistry(
          llmConfigSchema.parse({
              backends: { fake: { type: "fake" } },
              roles: {
                  gate: { backend: "fake", model: "scripted-gate" },
                  reply: { backend: "fake", model: "scripted" },
                  technical: { backend: "fake", model: "scripted" },
                  crisis: { backend: "fake", model: "scripted-crisis" },
                  vision: { backend: "fake", model: "scripted-vision" },
                  extract: { backend: "fake", model: "scripted-extract" },
                  consolidate: { backend: "fake", model: "scripted-consolidate" },
              },
          }),
          { fake: fakeFactory },
      )
    : new LlmRegistry({ backends: config.backends, roles: config.roles }, BACKEND_FACTORIES, (usage, _role, model) => cost.add(usage, model));

const runtime = new Runtime({
    clock,
    rng,
    trace,
    llm,
    cost,
    persona,
    adapters: [adapter],
    timing: { quietMs: 1500, maxWaitMs: 6000, candidateTtlMs: 120_000, windowSize: 40 },
    // Limits are loose here: with one human typing, a realistic share limit would silence the bot within a few turns.
    limits: { bucketCapacity: 30, refillPerMinute: 30, shareWindow: 20, maxShare: 0.95, minShareSample: 10 },
    // The simulated group is always allowed, and "admin" can run admin commands. Nothing here touches the real control state.
    control: {
        commandPrefix: config.control.commandPrefix,
        admins: [...config.control.admins, "cli:admin"],
        groups: [...config.control.groups, { platform: "cli", channelId: "group", disclosed: true }],
        crisisResources: config.control.crisisResources,
    },
    controlStore: new MemoryControlStore(),
    // Off by default so you can test at any hour and without waiting.
    routine: process.argv.includes("--routine"),
    ...(useFake ? {} : { search: createSearchBackend(config.search, (usage, model) => cost.add(usage, model)) }),
    ...(process.argv.includes("--paced") ? { pacing: config.pacing } : {}),
    // A separate database, so testing here never touches what the live bot remembers.
    memoryStore: new MemoryStore(useFake ? ":memory:" : SIM_DATABASE),
    embedder: useFake ? new NullEmbedder() : createEmbedder(config.embedder, (message) => console.log(`  [embedder] ${message}`)),
    memorySettings: {
        segmentGapMs: config.memory.segmentGapMinutes * 60_000,
        maxSegmentMessages: config.memory.maxSegmentMessages,
        rawRetentionMs: config.memory.rawRetentionDays * 86_400_000,
        dailyWritesPerUser: config.memory.dailyWritesPerUser,
    },
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

await runtime.start();
const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: persona.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
}).format(clock.now());
console.log(`${persona.name}'s local time: ${localTime} (${persona.timezone})`);
console.log(`Simulated group with ${persona.name} (config: ${configPath}, ${useFake ? "FAKE replies" : "real models"}).`);
console.log(
    `Type "name: message" to speak as someone, or just a message to speak as "you". @${persona.name} or @${persona.aliases[0] ?? persona.name} addresses it.`,
);
console.log(
    `Commands: /react <name> <emoji> reacts to her last message, /close ends the conversation so it gets remembered, /sleep runs the nightly job, /memories, /why [id], /cost, /trace, /verbose, /away, /back, /quit. Control, typed as "admin: ...": ${config.control.commandPrefix} mute|unmute|kill|resume|status\n`,
);

const input = createInterface({ input: process.stdin });
for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "/quit") break;
    if (line.startsWith("/react ")) {
        const [, speaker, emoji] = line.split(/\s+/);
        const lastSent = adapter.sent.at(-1);
        if (speaker && emoji && lastSent) adapter.reactFrom(speaker, lastSent.messageId, emoji);
    } else if (line === "/close") {
        await runtime.memory.closeSegment("cli:group");
    } else if (line === "/sleep") {
        console.log(await runtime.memory.consolidateNow());
    } else if (line === "/memories") {
        for (const memory of runtime.memory.store.all())
            console.log(`#${memory.id} [${memory.kind}/${memory.status}] conf=${memory.confidence} ${memory.gist}`);
    } else if (line === "/why" || line.startsWith("/why ")) {
        const lastSeen = trace.ofKind("message.observed").findLast((event) => event.detail?.observation === "new");
        const id = line.slice(4).trim() || lastSeen?.messageId || "";
        for (const event of trace.forMessage(id)) console.log(JSON.stringify(event));
    } else if (line === "/trace") {
        for (const event of trace.all()) console.log(JSON.stringify(event));
    } else if (line === "/cost") {
        console.log(cost.summary());
    } else if (line === "/verbose") {
        verbose = !verbose;
        console.log(`verbose ${verbose ? "on" : "off"}`);
    } else if (line === "/away") {
        runtime.body.goAway();
    } else if (line === "/back") {
        runtime.body.comeBack();
    } else {
        const match = /^([^:：\s]{1,20})[:：]\s*(.+)$/.exec(line);
        adapter.say(match?.[1] ?? "you", match?.[2] ?? line);
    }
}

input.close();
await runtime.whenIdle();
await runtime.memory.closeSegment("cli:group");
stopWatching();
await runtime.stop();
console.log(cost.summary());
process.exit(0);

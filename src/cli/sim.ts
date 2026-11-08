import { createInterface } from "node:readline/promises";
import { CliAdapter } from "../adapters/cli.ts";
import { loadConfig } from "../config.ts";
import { SystemClock } from "../lib/clock.ts";
import { CostMeter } from "../lib/cost.ts";
import { Rng } from "../lib/rng.ts";
import { DecisionTrace, type TraceEvent } from "../lib/trace.ts";
import { BACKEND_FACTORIES } from "../llm/factories.ts";
import { FakeBackend } from "../llm/fake.ts";
import { type BackendFactory, LlmRegistry, llmConfigSchema } from "../llm/registry.ts";
import { loadPersona } from "../persona/loader.ts";
import { Runtime } from "../runtime.ts";

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
    privateThought: "(fake backend)",
});

const useFake = process.argv.includes("--fake");
const { config, path: configPath } = loadConfig();
const persona = loadPersona(config.persona, process.env.GABRIEL_TIMEZONE || undefined);

if (!useFake && !process.env.ANTHROPIC_API_KEY && Object.values(config.backends).some((backend) => backend.type === "anthropic")) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env, or run `pnpm sim --fake` for canned replies.");
    process.exit(1);
}

const clock = new SystemClock();
const rng = new Rng(clock.now());
let verbose = true;
const trace = new DecisionTrace(clock, { sink: (event) => verbose && printEvent(event) });
const cost = new CostMeter({ clock, prices: config.prices, dailyBudgetUsd: config.dailyBudgetUsd });
const adapter = new CliAdapter({ clock, selfName: persona.name, aliases: persona.aliases, print: (line) => console.log(line) });

const fakeFactory: BackendFactory = (_config, model) =>
    new FakeBackend(() => (model === "scripted-gate" ? CANNED_GATE : JSON.stringify({ messages: [rng.pick(CANNED_REPLIES)] })));
const llm = useFake
    ? new LlmRegistry(
          llmConfigSchema.parse({
              backends: { fake: { type: "fake" } },
              roles: {
                  gate: { backend: "fake", model: "scripted-gate" },
                  reply: { backend: "fake", model: "scripted" },
                  technical: { backend: "fake", model: "scripted" },
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
console.log("Commands: /cost, /trace, /verbose, /away, /back, /quit\n");

const input = createInterface({ input: process.stdin });
for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "/quit") break;
    if (line === "/trace") {
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
await runtime.body.whenIdle();
await runtime.stop();
console.log(cost.summary());
process.exit(0);

function printEvent(event: TraceEvent): void {
    const detail = event.detail ?? {};
    if (event.kind === "gate.decision") {
        const features = detail.features as { topic: string; interest: number; difficulty: number; domain: string; privateThought: string };
        const chance = `${Math.round((detail.probability as number) * 100)}%`;
        console.log(
            `  [gate] ${detail.speak ? "SPEAK" : "stay quiet"} (chance ${chance}, ${detail.addressed ? "addressed" : "not addressed"}) ` +
                `topic="${features.topic}" interest=${features.interest} mode=${detail.mode}${detail.slip ? "+slip" : ""} ` +
                `${features.domain}/${features.difficulty} thought="${features.privateThought}"`,
        );
    } else if (
        [
            "gate.silent",
            "reply.silent",
            "reply.chose_silence",
            "reply.code_too_long",
            "budget.exceeded",
            "send.blocked",
            "send.failed",
            "body.attend_failed",
        ].includes(event.kind)
    ) {
        console.log(`  [${event.kind}] ${JSON.stringify(detail)}`);
    }
}

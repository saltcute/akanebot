import { createInterface } from "node:readline/promises";
import { CliAdapter } from "../adapters/cli.ts";
import { SystemClock } from "../lib/clock.ts";
import { Rng } from "../lib/rng.ts";
import { DecisionTrace } from "../lib/trace.ts";
import { FakeBackend } from "../llm/fake.ts";
import { LlmRegistry, llmConfigSchema } from "../llm/registry.ts";
import { Runtime } from "../runtime.ts";

const SELF_NAME = "gabriel";
const CANNED_REPLIES = ["哈哈", "真的假的", "不知道诶", "lol", "等下 我看看", "?"];

const clock = new SystemClock();
const rng = new Rng(clock.now());
const trace = new DecisionTrace(clock);
const adapter = new CliAdapter({ clock, selfName: SELF_NAME, print: (line) => console.log(line) });
const llm = new LlmRegistry(
    llmConfigSchema.parse({ backends: { fake: { type: "fake" } }, roles: { reply: { backend: "fake", model: "scripted" } } }),
    { fake: () => new FakeBackend(() => rng.pick(CANNED_REPLIES)) },
);
const runtime = new Runtime({
    clock,
    trace,
    llm,
    adapters: [adapter],
    timing: { quietMs: 1200, maxWaitMs: 6000, candidateTtlMs: 60_000, windowSize: 40 },
    limits: { bucketCapacity: 10, refillPerMinute: 6, shareWindow: 20, maxShare: 0.4, minShareSample: 5 },
});

await runtime.start();
console.log(`Simulated group. Type "name: message", or just a message to speak as "you". Mention @${SELF_NAME} to address it.`);
console.log("Commands: /trace shows the decision trace, /away and /back move the body, /quit exits. Replies are canned for now.\n");

const input = createInterface({ input: process.stdin });
for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "/quit") break;
    if (line === "/trace") {
        for (const event of trace.all()) console.log(JSON.stringify(event));
    } else if (line === "/away") {
        runtime.body.goAway();
    } else if (line === "/back") {
        runtime.body.comeBack();
    } else {
        const match = /^([^:\s]{1,20}):\s*(.+)$/.exec(line);
        adapter.say(match?.[1] ?? "you", match?.[2] ?? line);
    }
}

input.close();
await runtime.stop();
process.exit(0);

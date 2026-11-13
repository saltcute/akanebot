import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config.ts";
import { chatOf, type Entry, entriesOf, type Filter, nextPair, ORIGINAL, pendingCaptures, replayReport, runReplay } from "../eval/replay.ts";
import { SystemClock } from "../lib/clock.ts";
import { costOf } from "../lib/cost.ts";
import { Rng } from "../lib/rng.ts";
import { BACKEND_FACTORIES } from "../llm/factories.ts";
import { FakeBackend } from "../llm/fake.ts";
import { type BackendFactory, LlmRegistry } from "../llm/registry.ts";
import { MemoryStore } from "../memory/store.ts";

const SIM_DATABASE = "data/sim-memory.db";
const CHAT_LINES_SHOWN = 30;
const USAGE = `Usage: pnpm replay [--sim] <command> [options]
  status                      what's captured, replayed and rated so far
  run                         try each candidate in replay.candidates on captures it hasn't answered yet
      --limit N               at most this many captures (default 50)
      --max-usd X             stop starting calls past this spend (default 1)
      --only a,b              just these candidates
      --concurrency N         calls at once (default 4)
      --yes                   don't ask before spending
      --fake                  canned answers, no API calls
  rate                        blind side by side: 1 or 2 for the better reply, t for a tie, s to skip, q to quit
      --pair a,b              compare these two instead of each candidate against what she said
  report                      cost, length, silence and win rates for each
  show <id>                   one capture's chat and every answer to it
Any command takes --with-pictures to include replies that saw pictures. Candidates only get those pictures' descriptions.`;

const args = process.argv.slice(2);
const useSim = args[0] === "--sim";
if (useSim) args.shift();
const [command, ...rest] = args;

function flag(name: string): boolean {
    return rest.includes(`--${name}`);
}

function option(name: string): string | undefined {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
}

function numberOption(name: string, fallback: number): number {
    const value = option(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) fail(`--${name} needs a positive number`);
    return parsed;
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

const { config } = loadConfig();
const store = new MemoryStore(useSim ? SIM_DATABASE : config.memory.path);
const clock = new SystemClock();
const rng = new Rng(clock.now());
const filter: Filter = { includePictures: flag("with-pictures") };
const candidateNames = Object.keys(config.replay.candidates);

function money(usd: number): string {
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function when(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function describeReply(entry: Entry): string[] {
    if (entry.result !== "ok" || !entry.reply) return [`  (${entry.result})`];
    const lines = entry.reply.messages.map((message) => `  ${message}`);
    if (entry.reply.image !== undefined) lines.push(`  [sends saved picture ${entry.reply.image}]`);
    return lines.length > 0 ? lines : ["  (says nothing)"];
}

function status(): void {
    const all = store.replyCaptures();
    const outputs = store.replayOutputs();
    console.log(`Capturing is ${config.replay.capture ? "on" : "off (set replay.capture: true in config and restart)"}.`);
    if (all.length === 0) {
        console.log("Nothing captured yet.");
    } else {
        const roles = new Map<string, number>();
        for (const capture of all) roles.set(capture.role, (roles.get(capture.role) ?? 0) + 1);
        const pictures = all.filter((capture) => capture.sawPictures).length;
        console.log(`${all.length} captured from ${when(all[0]?.capturedAt ?? 0)} to ${when(all.at(-1)?.capturedAt ?? 0)} UTC.`);
        console.log(`  by role: ${[...roles].map(([role, count]) => `${role} ${count}`).join(", ")}; ${pictures} saw pictures`);
    }
    console.log(`Candidates: ${candidateNames.length > 0 ? candidateNames.join(", ") : "none (add some under replay.candidates)"}`);
    for (const name of new Set(outputs.map((output) => output.candidate))) {
        const mine = outputs.filter((output) => output.candidate === name);
        console.log(`  ${name}: ${mine.length} answered, ${mine.filter((output) => output.result !== "ok").length} failed`);
    }
    console.log(`${store.replayRatings().length} ratings.`);
}

async function run(): Promise<void> {
    const only = option("only")?.split(",");
    const candidates = only ?? candidateNames;
    const unknown = candidates.filter((name) => !candidateNames.includes(name));
    if (candidates.length === 0) fail("No candidates. Add some under replay.candidates in config.");
    if (unknown.length > 0) fail(`Not in replay.candidates: ${unknown.join(", ")}`);
    const useFake = flag("fake");
    if (!useFake && !process.env.ANTHROPIC_API_KEY && Object.values(config.backends).some((backend) => backend.type === "anthropic")) {
        fail("ANTHROPIC_API_KEY is not set. Put it in .env, or pass --fake.");
    }
    const fakeFactory: BackendFactory = () => new FakeBackend(() => JSON.stringify({ messages: ["（假的回复）"] }));
    const factories = useFake ? Object.fromEntries(Object.keys(BACKEND_FACTORIES).map((type) => [type, fakeFactory])) : BACKEND_FACTORIES;
    const llm = new LlmRegistry({ backends: config.backends, roles: config.replay.candidates }, factories);
    const limit = numberOption("limit", 50);
    const maxUsd = numberOption("max-usd", 1);
    // The same fork twice, so the run picks exactly the captures the estimate was for.
    const runRng = rng.fork("run");

    const pending = pendingCaptures({ ...filter, store, candidates, rng: runRng.fork("pick"), limit });
    if (pending.length === 0) {
        console.log("Every candidate has already answered every capture.");
        return;
    }
    // A guess: as many tokens as the original answer used, at each candidate's prices. Thinking changes it.
    const estimate = pending.reduce(
        (total, { capture, missing }) =>
            total +
            missing.reduce((sum, name) => {
                const price = config.prices[llm.modelOf(name) ?? ""];
                return sum + (price ? costOf(capture.usage, price) : 0);
            }, 0),
        0,
    );
    const calls = pending.reduce((total, { missing }) => total + missing.length, 0);
    console.log(
        `${pending.length} captures, ${calls} calls. If they use as many tokens as the original did, about ${money(estimate)}. Cap ${money(maxUsd)}.`,
    );
    if (!useFake && !flag("yes")) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question("Go ahead? [y/N] ");
        prompt.close();
        if (answer.trim().toLowerCase() !== "y") return;
    }
    const summary = await runReplay({
        ...filter,
        store,
        llm,
        candidates,
        prices: config.prices,
        clock,
        rng: runRng.fork("pick"),
        limit,
        maxUsd,
        concurrency: numberOption("concurrency", 4),
        onResult: (output, spent) =>
            console.log(
                `  #${output.captureId} ${output.candidate}: ${output.result} in ${(output.latencyMs / 1000).toFixed(1)}s, ${money(spent)} so far`,
            ),
    });
    console.log(`Done: ${summary.calls} calls, ${money(summary.spentUsd)}.${summary.stoppedForBudget ? " Stopped at the cap." : ""}`);
    if (summary.unpriced.length > 0) console.log(`No prices in config for ${summary.unpriced.join(", ")}, so those weren't counted.`);
}

async function rate(): Promise<void> {
    const pairOption = option("pair")?.split(",");
    if (pairOption && pairOption.length !== 2) fail("--pair takes two names, like original,sonnet-low");
    const pairs = pairOption ? [[pairOption[0] ?? "", pairOption[1] ?? ""] as const] : undefined;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    // Input running out, as with a pipe or Ctrl-D, counts as quitting.
    const closed = new Promise<string>((resolve) => prompt.once("close", () => resolve("q")));
    let rated = 0;
    try {
        for (;;) {
            const pair = nextPair({ ...filter, store, rng, ...(pairs ? { pairs } : {}) });
            if (!pair) {
                console.log(rated === 0 ? "Nothing left to rate. Run `pnpm replay run` first." : "That's everything for now.");
                return;
            }
            const { capture, first, second } = pair;
            console.log(`\n──── #${capture.id} · ${capture.channel} · ${when(capture.capturedAt)} UTC · rated ${rated} this session ────`);
            for (const line of chatOf(capture.transcript).slice(-CHAT_LINES_SHOWN)) console.log(line);
            console.log("── 1 ──");
            for (const line of describeReply(first)) console.log(line);
            console.log("── 2 ──");
            for (const line of describeReply(second)) console.log(line);
            const answer = (await Promise.race([prompt.question("Better? [1/2/t/s/q] "), closed])).trim().toLowerCase();
            if (answer === "q") return;
            const winner = answer === "1" ? first.name : answer === "2" ? second.name : answer === "t" ? "tie" : undefined;
            if (!winner) continue;
            store.saveReplayRating({ captureId: capture.id, first: first.name, second: second.name, winner, ratedAt: clock.now() });
            rated++;
        }
    } finally {
        prompt.close();
    }
}

function report(): void {
    const result = replayReport({ ...filter, store, prices: config.prices });
    if (result.replayed === 0) {
        console.log("Nothing replayed yet. Run `pnpm replay run` first.");
        return;
    }
    console.log(
        `${result.replayed} of ${result.captures} captures replayed. She made about ${result.repliesPerDay.toFixed(0)} replies a day while capturing.\n`,
    );
    const header = ["", "model", "answers", "failed", "silent", "msgs", "chars", "in tok", "out tok", "per reply", "per day", "latency"];
    const rows = result.entrants.map((entrant) => [
        entrant.name,
        entrant.models.join("/"),
        String(entrant.answers),
        String(entrant.failed),
        String(entrant.silent),
        entrant.avgMessages.toFixed(1),
        entrant.avgChars.toFixed(0),
        entrant.avgInputTokens.toFixed(0),
        entrant.avgOutputTokens.toFixed(0),
        money(entrant.avgCostUsd),
        money(entrant.perDayUsd),
        entrant.medianLatencyMs === undefined ? "" : `${(entrant.medianLatencyMs / 1000).toFixed(1)}s`,
    ]);
    const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)));
    for (const row of [header, ...rows]) console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  "));
    console.log(`\n"per day" is only the reply model, at the rate she replied while capturing. Latency of "${ORIGINAL}" wasn't recorded.`);
    if (result.headToHead.length === 0) {
        console.log("No ratings yet. Run `pnpm replay rate`.");
        return;
    }
    console.log("\nBlind ratings:");
    for (const { a, b, aWins, bWins, ties } of result.headToHead) {
        const decided = aWins + bWins;
        const share = decided === 0 ? "" : ` (${a} wins ${((aWins / decided) * 100).toFixed(0)}% of decided)`;
        console.log(`  ${a} ${aWins} : ${bWins} ${b}, ${ties} ties${share}`);
    }
}

function show(id: number): void {
    const capture = store.replyCaptures().find((each) => each.id === id);
    if (!capture) fail(`No capture #${id}. It may have been forgotten along with something it showed.`);
    console.log(
        `#${capture.id} · ${capture.channel} · ${when(capture.capturedAt)} UTC · ${capture.role} · ${capture.sawPictures ? "saw pictures" : "text only"}`,
    );
    console.log(capture.transcript);
    console.log(`── state ──\n${capture.volatile}`);
    for (const entry of entriesOf(capture, store.replayOutputs())) {
        console.log(`── ${entry.name} (${entry.model}) ──`);
        for (const line of describeReply(entry)) console.log(line);
    }
}

switch (command) {
    case "status":
        status();
        break;
    case "run":
        await run();
        break;
    case "rate":
        await rate();
        break;
    case "report":
        report();
        break;
    case "show":
        show(Number(rest[0]));
        break;
    default:
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
}
store.close();

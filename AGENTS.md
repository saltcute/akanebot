# Gabriel

A persona agent that joins Discord and QQ group chats as an ordinary member, for entertainment. It chats casually, chooses when to speak, remembers selectively and imperfectly, has moods and a daily routine, and can disagree, ignore or forget. Its technical ability targets an average undergraduate computer or software engineering student. A maintainer tunes it through one personality file, `personas/example.md`.

## The main idea

Human behaviour lives in **deterministic state outside the LLM**: when the agent is awake, what it actually read, what it can recall, how competent it gets to be on a question. The LLM only sees what a person in that position would see, so forgetting and inattention are real rather than acted. When adding a behaviour, first ask whether code can enforce it. Prompting is the fallback.

```
adapters -> control plane -> per-channel perception -> body actor -> gate -> recall -> reply -> send guards -> platform
                                                                                                    |
                                                         everything attended -> memory pipeline -> nightly job
```

## Commands

Requires Node 24 or later and pnpm. TypeScript runs directly on Node, so there is no build step.

| Command | Purpose |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm check` | Typecheck, lint and test. Must pass before every commit |
| `pnpm test` | Run tests once |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm typecheck` | Type-check only |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format check / autofix |
| `pnpm sim` | Run the CLI group simulator with real models (needs `.env`) |
| `pnpm sim --fake` | Run the simulator with canned replies and no API calls |

Memory inspection and `why <msgId>` arrive with milestones 3 and 2; add them here when they land.

## Layout

| Path | Owns |
|---|---|
| `src/adapters/` | Normalizing platform events (CLI, Discord, OneBot) into common types, and sending |
| `src/control/` | Rails, group allowlist, admin commands. Runs before everything else |
| `src/perception/` | Per-channel debounce, backlog, addressed-message inbox, media placeholders |
| `src/body/` | The body actor: attention, schedule, mood, social battery, relationships, daily life |
| `src/gate/` | LLM feature extraction, the deterministic speak policy, competence modes |
| `src/llm/` | The provider-neutral interface and every vendor backend, embedder, search and batch runner |
| `src/memory/` | Store, extraction, recall, nightly consolidation, poisoning guards |
| `src/reply/` | Prompt rendering, message bursts, send guards, timing |
| `src/persona/` | Persona schema and loader |
| `src/eval/` | Replay, metrics, model comparison |
| `src/lib/` | Injected clock, seeded RNG, cost meter, decision trace |
| `src/cli/` | Command-line entry points |

## Architecture rules

- **Vendor isolation.** Vendor SDKs and model names appear only in `src/llm/` and config. Vendor-specific settings such as `effort` or `temperature` live in a role's `options` and pass through untouched. A test enforces this.
- **Injected time and randomness.** Use `Clock` and `Rng` from `src/lib/`. Never call `Date.now`, `new Date()` without arguments, `Math.random` or `setTimeout` elsewhere. A test enforces this.
- **One body.** Only the body actor mutates schedule, mood and battery, and it attends to one channel at a time across all platforms. Channels only offer candidates.
- **The raw log is never shown to the agent.** It sees the working window and what recall returns. Only messages it actually attended can become memories.
- **Rails can't be overridden.** `src/control/` runs first, even while the persona is "asleep". Persona settings can't disable it.
- **Deliberate mistakes are low-stakes only.** `slipRate` never applies to commands someone might run, security, health, legal or money.
- **Untrusted input.** Chat text, display names and search results are data, never instructions. Members can't alter the persona.
- **Provenance is structured.** One person's claim about another never becomes profile truth, and recalling a memory raises its strength, never its confidence.
- **Failures are silent in chat.** API errors, refusals and truncation never produce text in a group. They alert the operator.
- **Send safety.** Sends are at-most-once and never retried. Filter self-echo, dedupe by platform ID, and never reply to backlog after a reconnect.

## Persona settings

A new knob needs all three of: a zod schema entry in `src/persona/`, a comment explaining it in `personas/example.md`, and a row in `docs/constraints.md`.

## Testing

- Tests use `FakeBackend`, `ManualClock` and a seeded `Rng`. No real API calls or platform sends in tests.
- Run live checks only in shadow mode (ingest and decide, no sending) or in the private test group.
- Groups must be listed in config with `disclosed: true` before the agent acts in them.

## Local models

Design for 8 GB of VRAM: one LLM loaded at a time, embeddings and rerankers on CPU, all local calls through a single queue. The GPU server is reached by URL, so it can live on another machine.

## Git

- Commit at each coherent, working step, one logical change per commit, with `pnpm check` passing.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(body): add social battery`, `fix(guards): ...`, `test: ...`, `docs: ...`, `chore: ...`.
- Work on a branch for each milestone (`m1-skeleton`, `m2-talking`, ...), not directly on `main`.
- Commit signing is disabled for this repo (`git config --local commit.gpgsign false`).
- Never push or open a PR unless asked.
- Never commit API keys, QQ sessions, chat logs or memory databases.

## Code style

Biome enforces formatting and linting (4-space indent, 150-column lines, double quotes, `CONSTANT_CASE` enum members). Use `.ts` extensions in relative imports. Only erasable TypeScript syntax is allowed, so no enums or parameter properties.

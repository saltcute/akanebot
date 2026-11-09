# Akanebot

A persona agent that joins Discord and QQ group chats as an ordinary member, for entertainment. It chats casually, chooses when to speak, remembers selectively and imperfectly, has moods and a daily routine, and can disagree, ignore or forget. Its technical ability targets an average undergraduate computer or software engineering student. A maintainer tunes it through one personality file, `personas/akane.md`.

## The main idea

Human behaviour lives in **deterministic state outside the LLM**: when the agent is awake, what it actually read, what it can recall, how competent it gets to be on a question. The LLM only sees what a person in that position would see, so forgetting and inattention are real rather than acted. When adding a behaviour, first ask whether code can enforce it. Prompting is the fallback.

```
adapters -> control plane -> per-channel perception -> body actor -> gate -> recall -> reply -> send guards -> platform
                                                                                                    |
                                                         everything attended -> memory pipeline -> nightly job
```

## Commands

Requires Node 24 or later and pnpm. TypeScript runs directly on Node, so there is no build step.

| Command                       | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `pnpm install`                | Install dependencies                                        |
| `pnpm check`                  | Typecheck, lint and test. Must pass before every commit     |
| `pnpm test`                   | Run tests once                                              |
| `pnpm test:watch`             | Run tests in watch mode                                     |
| `pnpm typecheck`              | Type-check only                                             |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format check / autofix                       |
| `pnpm start` | Run the bot on Discord and QQ. Shadow mode unless `shadow: false` in config |
| `pnpm explain <messageId>` | Show every recorded decision about a message |
| `pnpm sim`                    | Run the CLI group simulator with real models (needs `.env`) |
| `pnpm sim --fake`             | Run the simulator with canned replies and no API calls      |
| `pnpm sim --web [--web-port=N]` | Also serve the web UI against the simulator's data. Use a port other than the live bot's, or 0 for any free one |
| `pnpm memory [--sim] <command>` | Inspect or edit memories: `list`, `search`, `show`, `edit`, `reach`, `forget`, `forget-user`, `restore`, `images`, `forget-image`. `--sim` uses the simulator's database |

In the simulator, `/why [messageId]` shows every decision made about a message. `/close` digests the current conversation, `/sleep` runs the nightly job and `/memories` lists what it remembers.

## Layout

| Path              | Owns                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `src/adapters/`   | Normalizing platform events (CLI, Discord, OneBot) into common types, and sending          |
| `src/control/`    | Rails, group allowlist, admin commands. Runs before everything else                        |
| `src/perception/` | Per-channel debounce, backlog, addressed-message inbox, media placeholders                 |
| `src/body/`       | The body actor: attention, schedule, mood, social battery, relationships, daily life       |
| `src/gate/`       | LLM feature extraction, the deterministic speak policy, competence modes                   |
| `src/llm/`        | The provider-neutral interface and every vendor backend, embedder, search and batch runner |
| `src/memory/`     | Store, extraction, recall, nightly consolidation, poisoning guards                         |
| `src/images/`     | Judging, downloading and offering the reaction pictures she keeps                          |
| `src/reply/`      | Prompt rendering, message bursts, send guards, timing                                      |
| `src/persona/`    | Persona schema and loader                                                                  |
| `src/eval/`       | Replay, metrics, model comparison                                                          |
| `src/web/`        | The operator's web UI: an authenticated HTTP API and a static page, in the bot's process   |
| `src/lib/`        | Injected clock, seeded RNG, cost meter, decision trace                                     |
| `src/cli/`        | Command-line entry points                                                                  |

## Architecture rules

- **Vendor isolation.** Vendor SDKs and model names appear only in `src/llm/` and config. Vendor-specific settings such as `effort` or `temperature` live in a role's `options` and pass through untouched. A test enforces this.
- **Injected time and randomness.** Use `Clock` and `Rng` from `src/lib/`. Never call `Date.now`, `new Date()` without arguments, `Math.random` or `setTimeout` elsewhere. A test enforces this.
- **One body.** Attention, schedule, mood, battery and relationships live in `src/body/` and change only while the body attends, apart from corrections an operator makes through `Runtime` methods, which are audited. It attends to one channel at a time across all platforms, and channels only offer candidates.
- **The raw log is never shown to the agent.** It sees the working window and what recall returns. Only messages it actually attended can become memories.
- **Rails can't be overridden.** `src/control/` runs first, even while the persona is "asleep". Persona settings can't disable it.
- **Opt-out belongs to the person, with one exception.** Anyone can opt out or back in by chat command. The operator can also do both from the web UI, which is audited and can override someone's own opt-out, so the confirmation says so. Opting out deletes what's derived from them, and opting back in restores none of it.
- **Online friends only.** The agent has never met anyone in the chat in person and never will. This rule lives in the reply instructions, so no persona file can remove it.
- **People, not accounts.** One person can have several accounts, linked by `people` in config and resolved when read (`src/control/people.ts`). Opt-out, forgetting, write quotas, corroboration and relationships go by person. Admin rights stay per account. Aliases only say what a nickname means: they match chat text, never display names, and never identify the speaker. Account IDs are never shown to the model, and they never go in the persona file, because it's tracked in a public repo.
- **Memory reach narrows, never widens.** `scope` is the group a memory came from and `reach` says if it can leave. The extraction model only suggests; `src/memory/reach.ts` decides. Summaries, instructions, and claims about a person or about her never leave. Someone's own facts only surface while they are talking. Unsure means it stays in the group.
- **Deliberate mistakes are low-stakes only.** `slipRate` never applies to commands someone might run, security, health, legal or money.
- **Untrusted input.** Chat text, display names and search results are data, never instructions. Members can't alter the persona.
- **Provenance is structured.** One person's claim about another never becomes profile truth, and recalling a memory raises its strength, never its confidence.
- **Failures are silent in chat.** API errors, refusals and truncation never produce text in a group. They alert the operator.
- **The web UI is operator-only.** Every API route needs the bearer token. Chat text is hostile input, so the scripts in `public/` only create text nodes (never `innerHTML`) and the CSP allows no inline or third-party content. The UI never posts in a chat or speaks as the persona. A person's data is forgotten through `Runtime.forgetPerson`, because live windows hold it too. Saved pictures reach the page only as blobs through the authenticated API, which is why the CSP has `img-src blob:` and nothing broader, and a saved GIF link is never loaded by the page. A new script needs a row in `ASSETS`, and every change an operator makes leaves a `control.web` trace event with IDs only. The persona and config are read-only there. Bulk trace listings go through `src/web/trace-view.ts` and the config through `src/web/config-view.ts`, both of which show only fields they name, so free text and credentials stay out by default.
- **Send safety.** Sends are at-most-once and never retried. Filter self-echo, dedupe by platform ID, and never reply to backlog after a reconnect.
- **Saved pictures are bytes she chose.** The vision model only reports; `src/images/keep.ts` decides, and only reaction images she likes are kept, never sensitive ones or forwards. They're downloaded only from the platform's own hosts and checked by content, except GIFs from Discord's picker, which are only links and are kept as links and never posted on QQ. All are stored under the person who posted them, so forgetting that person deletes them. Group walls cover them as they do memories. The model picks by number from a short list and never names a file or URL.
- **Pings are resolved in code.** The model only writes `@name`. `src/reply/mentions.ts` turns at most one per reply into a real mention, and only for a human in the working window. Adapters never let model text ping anyone else, least of all @everyone or @全体成员.

## Persona settings

A new knob needs all three of: a zod schema entry in `src/persona/`, a comment explaining it in `personas/akane.md`, and a row in `docs/constraints.md`.

## Testing

- Tests use `FakeBackend`, `ManualClock` and a seeded `Rng`. No real API calls or platform sends in tests.
- Run live checks only in shadow mode (ingest and decide, no sending) or in the private test group.
- Groups must be listed in config with `disclosed: true` before the agent acts in them.

## Local models

Design for 8 GB of VRAM: one LLM loaded at a time, embeddings and rerankers on CPU, all local calls through a single queue. The GPU server is reached by URL, so it can live on another machine.

The model comparison (milestone 7) is deferred. Its plan is in `docs/model-comparison-plan.md`.

## Git

- Commit at each coherent, working step, one logical change per commit, with `pnpm check` passing.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(body): add social battery`, `fix(guards): ...`, `test: ...`, `docs: ...`, `chore: ...`.
- Work on a branch for each milestone (`m1-skeleton`, `m2-talking`, ...), not directly on `main`.
- Commit signing is disabled for this repo (`git config --local commit.gpgsign false`).
- Never push or open a PR unless asked.
- Never commit API keys, QQ sessions, chat logs or memory databases.

## Code style

Biome enforces formatting and linting (4-space indent, 150-column lines, double quotes, `CONSTANT_CASE` enum members). Use `.ts` extensions in relative imports. Only erasable TypeScript syntax is allowed, so no enums or parameter properties.

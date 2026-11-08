# Model comparison plan (milestone 7)

**Status:** deferred on 2026-11-08, nothing built yet. Milestones 1 to 6 are done. Results should go in `docs/model-comparison.md`.

## Goal

Find out which model should do each job, and whether smaller models under the LLM improve quality or cost. Also confirm Akane's technical skill sits at the level of an average undergraduate computer or software engineering student: neither too weak nor too strong.

## Before starting

1. Agree an API budget, because the comparison makes real model calls.
2. Fix the NVIDIA driver for the local-model part: `nvidia-smi` could not reach the driver when last checked. The hosted-model part doesn't need this.
3. Collect real chat to replay, from shadow mode in a group whose members have agreed to it. The decision logs are in `data/trace/` and the messages in `data/memory.db`.

## What already exists

- Each job is a role in `config.yaml`, with its own backend, model and options, behind the interface in `src/llm/backend.ts`. Swapping a model is a config edit.
- `FakeBackend` for tests, `AnthropicBackend`, and `LlmRegistry` with per-role fallback.
- `CostMeter` for spend, and `DecisionTrace` for every gate decision.
- Separate `Embedder` and `SearchBackend` interfaces.

## What to build

| Piece | Location | Notes |
|---|---|---|
| OpenAI-compatible backend | `src/llm/openai-compat.ts` | Register it in `BACKEND_FACTORIES`. Used for `llama-server` and hosted DeepSeek or Qwen. Must absorb missing features: concatenate prompt parts without caching, join `volatile` to the final user message without trailing system messages, use a JSON-schema constraint or validate with zod and retry once |
| Backend conformance suite | `test/` | One shared suite that every backend must pass |
| Local model queue | `src/llm/` | One queue, gate before reply. Falls back to the role's hosted model when the server is down or the queue backs up |
| Eval harness | `src/eval/` | Replay, metrics, comparison report |
| Competence question set | `src/eval/` | Labelled questions per subject at difficulty 1 to 5 |
| Batch runner (optional) | `src/llm/` | The nightly job currently makes normal API calls. Batches are 50% off, but the volume is small |

## What to compare

| Role | Current default | Compare against |
|---|---|---|
| `gate` | Haiku 5.5 | Rules only; local embeddings with logistic regression trained on labelled logs; local 8–9B LLM |
| `reply` | Opus 5.5, low effort | Sonnet 5.5; local 8–9B LLM; hosted DeepSeek or Qwen, which may suit QQ-style Chinese better |
| `technical` | Opus 5.5, medium effort | Sonnet 5.5; local 8–9B LLM, only if it clears the competence floor |
| `extract` | Haiku 5.5 | Sonnet 5.5; local 8–9B LLM |
| `consolidate` | Sonnet 5.5 | Haiku 5.5; a local LLM, including a larger one split across GPU and RAM, since this job has no latency limit |
| `search` | Sonnet 5.5 with web search | Other search backends |
| Embeddings | multilingual-e5-small on CPU | bge-m3, if an ONNX build works |

**Expected findings, to be tested rather than assumed:** reply model choice dominates spend, so a local reply model is the only big saving. Local embeddings and the nightly job are the most likely places for small models to help. Gating is cheap enough on Haiku that replacing it may not pay off.

**Known embedding weakness:** a Chinese question matches an English memory poorly with e5-small. Check whether bge-m3 fixes this. Its `cosineFloor` and `cosineCeiling` must be measured again, because the current 0.84 and 0.92 are specific to e5-small.

## How to measure

Replay can't judge what would have happened after a message the original chat never saw, so don't score replies by replaying them against what came next.

- **Gate decisions:** label them offline and compare.
- **Replies:** blind pairwise ratings.
- **Track:** rate of answering direct questions, her share of messages, abandoned drafts, whether humans respond to her, cost and latency.
- **Competence:** starting targets to tune are about 75% or better at difficulty 1–2, 40–65% at difficulty 3, and under 30% at difficulty 5. A model that misses the floor can't hold the `technical` role. If Opus scores above the ceiling, prompting isn't enough and a weaker model is the fix.

## Local hardware limits

The machine has 6 CPU cores, 62 GB of RAM, and an RTX 3070 Ti (8 GB) or 3080 (10 GB). Design for 8 GB.

- One LLM in VRAM at a time. Candidates are Qwen3.5 9B Q4_K_M (about 5.3 GiB) and Qwen3 8B Q4_K_M (about 5.2 GB).
- Run it as `llama-server` with all layers on the GPU, one slot and about 8K tokens of context. It's reached by URL, so the GPU can be on another machine.
- Embeddings and any reranker stay on CPU and system RAM.
- The 3080's extra 2 GB goes to a larger context, not a second model.
- Speed and VRAM figures so far come from third-party guides. Measure them on the actual card, including peak VRAM.

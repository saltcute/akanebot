// biome-ignore-all lint/style/useNamingConvention: these objects are the Anthropic API wire format
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import type { BackendCapabilities, LlmBackend, LlmRequest, LlmResult, Usage } from "./backend.ts";
import type { BackendFactory } from "./registry.ts";
import { SEARCH_INSTRUCTIONS, type SearchBackend, type SearchConfig, type SearchResult } from "./search.ts";

const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const REQUEST_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 45_000;

/** `effort`, `thinking` and `refusalFallback` come from the role's `options` in config. */
export class AnthropicBackend implements LlmBackend {
    readonly capabilities: BackendCapabilities = { promptCache: true, structured: "native", trailingSystem: true, vision: true };
    #client: Anthropic;
    #model: string;

    constructor(client: Anthropic, model: string) {
        this.#client = client;
        this.#model = model;
    }

    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
        try {
            const message = await this.#send(request);
            return toResult(message, request.schema);
        } catch (error) {
            return toError(error);
        }
    }

    #send<T>(request: LlmRequest<T>): Promise<Anthropic.Message> {
        const { effort, thinking, refusalFallback } = request.options;
        const outputConfig = {
            ...(effort ? { effort } : {}),
            ...(request.schema ? { format: zodOutputFormat(request.schema as never) } : {}),
        };
        const content = request.images?.length
            ? [
                  ...request.images.flatMap(({ url, label, inline }) => [
                      ...(label ? [{ type: "text", text: label }] : []),
                      { type: "image", source: inline ? { type: "base64", media_type: inline.mediaType, data: inline.data } : { type: "url", url } },
                  ]),
                  { type: "text", text: request.transcript },
              ]
            : request.transcript;
        const messages: unknown[] = [{ role: "user", content }];
        // A trailing system message carries the changing state without disturbing the cached prefix.
        if (request.volatile) messages.push({ role: "system", content: request.volatile });
        const params = {
            model: this.#model,
            max_tokens: request.maxOutput,
            ...(request.stable ? { system: [{ type: "text", text: request.stable, cache_control: { type: "ephemeral" } }] } : {}),
            ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
            ...(thinking ? { thinking } : {}),
            messages,
        };
        const callOptions = { signal: request.signal, timeout: REQUEST_TIMEOUT_MS };
        if (refusalFallback) {
            const beta = { ...params, fallbacks: "default", betas: [REFUSAL_FALLBACK_BETA] };
            return this.#client.beta.messages.create(beta as never, callOptions) as unknown as Promise<Anthropic.Message>;
        }
        return this.#client.messages.create(params as never, callOptions) as unknown as Promise<Anthropic.Message>;
    }
}

/** Uses Anthropic's server-side search, so no search provider of our own is needed. */
export class AnthropicSearch implements SearchBackend {
    #client: Anthropic;
    #model: string;
    #maxUses: number;
    #onUsage: (usage: Usage, model: string) => void;

    constructor(options: { client: Anthropic; model: string; maxUses: number; onUsage: (usage: Usage, model: string) => void }) {
        this.#client = options.client;
        this.#model = options.model;
        this.#maxUses = options.maxUses;
        this.#onUsage = options.onUsage;
    }

    async search(query: string, signal: AbortSignal): Promise<SearchResult> {
        try {
            const params = {
                model: this.#model,
                max_tokens: 1500,
                system: SEARCH_INSTRUCTIONS,
                output_config: { effort: "low" },
                tools: [{ type: "web_search_20260209", name: "web_search", max_uses: this.#maxUses }],
                messages: [{ role: "user", content: `Topic: ${query}` }],
            };
            const message = (await this.#client.messages.create(params as never, {
                signal,
                timeout: SEARCH_TIMEOUT_MS,
            })) as unknown as Anthropic.Message;
            const searches = (message.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
            this.#onUsage({ ...toUsage(message.usage), webSearches: searches }, this.#model);
            if (message.stop_reason !== "end_turn") return { kind: "nothing" };
            // Only what comes after the last search is the finished note. Earlier text is the model thinking aloud.
            const lastSearch = message.content.findLastIndex((block) => block.type === "web_search_tool_result");
            const note = message.content
                .slice(lastSearch + 1)
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("")
                .trim();
            return note ? { kind: "found", note } : { kind: "nothing" };
        } catch {
            return { kind: "nothing" };
        }
    }
}

export function createAnthropicSearch(
    config: Extract<SearchConfig, { type: "anthropic" }>,
    onUsage: (usage: Usage, model: string) => void,
): SearchBackend {
    return new AnthropicSearch({ client: new Anthropic(), model: config.model, maxUses: config.maxUses, onUsage });
}

export const anthropicFactory: BackendFactory = (_config, model) => new AnthropicBackend(new Anthropic(), model);

function toResult<T>(message: Anthropic.Message, schema: ZodType<T> | undefined): LlmResult<T> {
    const usage = toUsage(message.usage);
    if (message.stop_reason === "refusal") return { kind: "refused", usage };
    if (message.stop_reason === "max_tokens") return { kind: "truncated", usage };
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (!schema) return { kind: "ok", text, usage };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { kind: "error", retryable: false, detail: "structured response was not JSON" };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { kind: "error", retryable: false, detail: `structured response failed its schema: ${parsed.error.message}` };
    return { kind: "ok", text, data: parsed.data, usage };
}

function toUsage(usage: Anthropic.Usage): Usage {
    return {
        // Cache writes count as plain input here, which slightly understates their cost.
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens,
    };
}

function toError<T>(error: unknown): LlmResult<T> {
    if (error instanceof Anthropic.APIUserAbortError) return { kind: "error", retryable: false, detail: "aborted" };
    if (error instanceof Anthropic.APIConnectionError) return { kind: "error", retryable: true, detail: error.message };
    if (error instanceof Anthropic.APIError) {
        const status = error.status ?? 0;
        return {
            kind: "error",
            retryable: status === 408 || status === 409 || status === 429 || status >= 500,
            detail: `${status}: ${error.message}`,
        };
    }
    return { kind: "error", retryable: false, detail: String(error) };
}

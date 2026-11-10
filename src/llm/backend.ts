import type { ZodType } from "zod";

export type Usage = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    webSearches?: number;
};

export type BackendCapabilities = {
    promptCache: boolean;
    structured: "native" | "json_schema" | "none";
    trailingSystem: boolean;
    vision: boolean;
};

export type LlmRequest<T> = {
    /** Persona and static examples: unchanged between calls, so it can be cached. */
    stable: string;
    /** The chat so far. Append-only between rebases. */
    transcript: string;
    /** Time, mood, recalled memories: changes on every call. */
    volatile: string;
    /**
     * Images to look at, passed alongside the transcript. A `label` is written just before its image, so the transcript can refer to it.
     * `inline` is the picture's own bytes, base64 encoded, sent instead of the URL.
     */
    images?: readonly { url: string; label?: string; inline?: { data: string; mediaType: string } }[];
    schema?: ZodType<T>;
    maxOutput: number;
    /** Vendor-specific settings from config. Only the backend reads these. */
    options: Record<string, unknown>;
    signal: AbortSignal;
};

export type LlmResult<T> =
    | { kind: "ok"; text: string; data?: T; usage: Usage }
    | { kind: "refused" | "truncated"; usage: Usage }
    | { kind: "error"; retryable: boolean; detail?: string };

export interface LlmBackend {
    readonly capabilities: BackendCapabilities;
    generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export const NO_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

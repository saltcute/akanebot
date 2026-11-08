import { type BackendCapabilities, type LlmBackend, type LlmRequest, type LlmResult, NO_USAGE } from "./backend.ts";

/** A plain string is the reply text, parsed as JSON when the request has a schema. */
export type FakeResponse = string | LlmResult<unknown>;
export type FakeResponder = (request: LlmRequest<unknown>) => FakeResponse;

/** Scripted backend for tests and the simulator. Makes no network calls. */
export class FakeBackend implements LlmBackend {
    readonly capabilities: BackendCapabilities;
    readonly calls: LlmRequest<unknown>[] = [];
    #respond: FakeResponder;

    constructor(script: FakeResponder | readonly FakeResponse[], capabilities: Partial<BackendCapabilities> = {}) {
        this.capabilities = { promptCache: false, structured: "native", trailingSystem: false, ...capabilities };
        if (typeof script === "function") {
            this.#respond = script;
        } else {
            const queue = [...script];
            this.#respond = () => queue.shift() ?? { kind: "error", retryable: false, detail: "fake script exhausted" };
        }
    }

    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
        this.calls.push(request as LlmRequest<unknown>);
        if (request.signal.aborted) return { kind: "error", retryable: false, detail: "aborted" };
        const response = this.#respond(request as LlmRequest<unknown>);
        if (typeof response !== "string") return response as LlmResult<T>;
        if (!request.schema) return { kind: "ok", text: response, usage: NO_USAGE };
        return parseStructured(response, request);
    }
}

function parseStructured<T>(text: string, request: LlmRequest<T>): LlmResult<T> {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { kind: "error", retryable: false, detail: "fake response was not JSON" };
    }
    const parsed = request.schema?.safeParse(raw);
    if (!parsed?.success) return { kind: "error", retryable: false, detail: "fake response failed the schema" };
    return { kind: "ok", text, data: parsed.data, usage: NO_USAGE };
}

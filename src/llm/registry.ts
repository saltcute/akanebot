import { z } from "zod";
import type { LlmBackend, LlmRequest, LlmResult, Usage } from "./backend.ts";

const roleTargetSchema = z.strictObject({
    backend: z.string().min(1),
    model: z.string().min(1),
    options: z.record(z.string(), z.unknown()).default({}),
});

const roleSchema = roleTargetSchema.extend({
    /** Used when the primary errors out, for example when the local GPU server is down. */
    fallback: roleTargetSchema.optional(),
});

export const llmConfigSchema = z.strictObject({
    backends: z.record(z.string(), z.looseObject({ type: z.string().min(1) })),
    roles: z.record(z.string(), roleSchema),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;
type RoleTarget = z.infer<typeof roleTargetSchema>;

export type BackendConfig = LlmConfig["backends"][string];
export type BackendFactory = (config: BackendConfig, model: string) => LlmBackend;

export type RoleRequest<T> = Omit<LlmRequest<T>, "options">;
export type UsageListener = (usage: Usage, role: string, model: string) => void;

/** Resolves role names to configured models, so changing a model is only a config edit. */
export class LlmRegistry {
    #config: LlmConfig;
    #factories: Readonly<Record<string, BackendFactory>>;
    #onUsage: UsageListener | undefined;
    #instances = new Map<string, LlmBackend>();

    constructor(config: LlmConfig, factories: Readonly<Record<string, BackendFactory>>, onUsage?: UsageListener) {
        this.#config = config;
        this.#factories = factories;
        this.#onUsage = onUsage;
    }

    async generate<T>(role: string, request: RoleRequest<T>): Promise<LlmResult<T>> {
        const target = this.#config.roles[role];
        if (!target) throw new Error(`No LLM role named "${role}" in config`);
        const result = await this.#call(role, target, request);
        if (result.kind !== "error" || !target.fallback || request.signal.aborted) return result;
        return this.#call(role, target.fallback, request);
    }

    async #call<T>(role: string, target: RoleTarget, request: RoleRequest<T>): Promise<LlmResult<T>> {
        const result = await this.#backend(target).generate({ ...request, options: target.options });
        if (result.kind !== "error") this.#onUsage?.(result.usage, role, target.model);
        return result;
    }

    #backend(target: RoleTarget): LlmBackend {
        const key = `${target.backend}\0${target.model}`;
        const existing = this.#instances.get(key);
        if (existing) return existing;
        const config = this.#config.backends[target.backend];
        if (!config) throw new Error(`No LLM backend named "${target.backend}" in config`);
        const factory = this.#factories[config.type];
        if (!factory) throw new Error(`Unknown LLM backend type "${config.type}"`);
        const backend = factory(config, target.model);
        this.#instances.set(key, backend);
        return backend;
    }
}

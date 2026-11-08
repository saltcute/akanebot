import { anthropicFactory, createAnthropicSearch } from "./anthropic.ts";
import type { Usage } from "./backend.ts";
import type { BackendFactory } from "./registry.ts";
import { NoSearch, type SearchBackend, type SearchConfig } from "./search.ts";

/** Every real backend type that config may name. */
export const BACKEND_FACTORIES: Readonly<Record<string, BackendFactory>> = {
    anthropic: anthropicFactory,
};

export function createSearchBackend(config: SearchConfig, onUsage: (usage: Usage, model: string) => void): SearchBackend {
    return config.type === "none" ? new NoSearch() : createAnthropicSearch(config, onUsage);
}

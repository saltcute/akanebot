import { anthropicFactory, createAnthropicLinkReader, createAnthropicSearch } from "./anthropic.ts";
import type { Usage } from "./backend.ts";
import { type LinkReader, type LinkReaderConfig, NoLinkReader } from "./links.ts";
import type { BackendFactory } from "./registry.ts";
import { NoSearch, type SearchBackend, type SearchConfig } from "./search.ts";

/** Every real backend type that config may name. */
export const BACKEND_FACTORIES: Readonly<Record<string, BackendFactory>> = {
    anthropic: anthropicFactory,
};

export function createSearchBackend(config: SearchConfig, onUsage: (usage: Usage, model: string) => void): SearchBackend {
    return config.type === "none" ? new NoSearch() : createAnthropicSearch(config, onUsage);
}

export function createLinkReader(config: LinkReaderConfig, onUsage: (usage: Usage, model: string) => void): LinkReader {
    return config.type === "none" ? new NoLinkReader() : createAnthropicLinkReader(config, onUsage);
}

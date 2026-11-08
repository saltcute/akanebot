import { anthropicFactory } from "./anthropic.ts";
import type { BackendFactory } from "./registry.ts";

/** Every real backend type that config may name. */
export const BACKEND_FACTORIES: Readonly<Record<string, BackendFactory>> = {
    anthropic: anthropicFactory,
};

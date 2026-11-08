import { z } from "zod";

export const embedderConfigSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("none") }),
    z.strictObject({
        type: z.literal("transformers"),
        model: z.string().min(1),
        dtype: z.string().default("q8"),
        cacheDir: z.string().default("data/models"),
        /** Cosine scores vary by model. Below the floor counts as unrelated, at the ceiling as a perfect match. */
        cosineFloor: z.number(),
        cosineCeiling: z.number(),
    }),
]);

export type EmbedderConfig = z.infer<typeof embedderConfigSchema>;
export type EmbedMode = "query" | "passage";

export interface Embedder {
    readonly modelId: string;
    readonly cosineFloor: number;
    readonly cosineCeiling: number;
    /** Resolves undefined when embeddings are unavailable, and recall then falls back to matching words. */
    embed(text: string, mode: EmbedMode): Promise<Float32Array | undefined>;
}

export class NullEmbedder implements Embedder {
    readonly modelId = "none";
    readonly cosineFloor = 0;
    readonly cosineCeiling = 1;

    async embed(): Promise<undefined> {
        return undefined;
    }
}

type Extractor = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>;

/** Runs on the CPU in ONNX Runtime's own threads, leaving VRAM free and the event loop responsive. */
export class TransformersEmbedder implements Embedder {
    readonly modelId: string;
    readonly cosineFloor: number;
    readonly cosineCeiling: number;
    #config: Extract<EmbedderConfig, { type: "transformers" }>;
    #onError: (message: string) => void;
    #extractor: Promise<Extractor | undefined> | undefined;

    constructor(config: Extract<EmbedderConfig, { type: "transformers" }>, onError: (message: string) => void) {
        this.#config = config;
        this.#onError = onError;
        this.modelId = config.model;
        this.cosineFloor = config.cosineFloor;
        this.cosineCeiling = config.cosineCeiling;
    }

    async embed(text: string, mode: EmbedMode): Promise<Float32Array | undefined> {
        this.#extractor ??= this.#load();
        const extractor = await this.#extractor;
        if (!extractor) return undefined;
        // The e5 model family expects these prefixes.
        const output = await extractor(`${mode}: ${text}`, { pooling: "mean", normalize: true });
        return Float32Array.from(output.data);
    }

    async #load(): Promise<Extractor | undefined> {
        try {
            const { pipeline, env } = await import("@huggingface/transformers");
            env.cacheDir = this.#config.cacheDir;
            const options = { dtype: this.#config.dtype } as Parameters<typeof pipeline>[2];
            return (await pipeline("feature-extraction", this.#config.model, options)) as unknown as Extractor;
        } catch (error) {
            this.#onError(`Embedder failed to load, recall will match words only: ${String(error)}`);
            return undefined;
        }
    }
}

export function createEmbedder(config: EmbedderConfig, onError: (message: string) => void): Embedder {
    return config.type === "none" ? new NullEmbedder() : new TransformersEmbedder(config, onError);
}

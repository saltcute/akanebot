import { z } from "zod";
import type { Usage } from "../llm/backend.ts";
import type { Clock } from "./clock.ts";

/** Dollars per million tokens. */
export const pricesSchema = z.record(
    z.string(),
    z.strictObject({ input: z.number().min(0), cachedInput: z.number().min(0), output: z.number().min(0), webSearch: z.number().min(0).optional() }),
);
export type Prices = z.infer<typeof pricesSchema>;

const DAY_MS = 86_400_000;
const SPEND_KEY = "dailySpend";
const PER_TOKEN = 1 / 1_000_000;

type SpendStore = { getMeta(key: string): string | undefined; setMeta(key: string, value: string): void };

/** Tracks spend per UTC day. An approximation, for capping and comparing, not for accounting. With a store, today's spend survives restarts, so restarting can't get around the cap. */
export class CostMeter {
    #clock: Clock;
    #prices: Prices;
    #dailyBudgetUsd: number;
    #day = -1;
    #spentToday = 0;
    #spentTotal = 0;
    #unpriced = new Set<string>();
    #store: SpendStore | undefined;

    constructor(options: { clock: Clock; prices: Prices; dailyBudgetUsd: number; store?: SpendStore }) {
        this.#clock = options.clock;
        this.#prices = options.prices;
        this.#dailyBudgetUsd = options.dailyBudgetUsd;
        this.#store = options.store;
        const saved = this.#store?.getMeta(SPEND_KEY);
        if (saved) {
            // An earlier day's total is dropped by the first roll, the same as at midnight.
            const { day, spentUsd } = JSON.parse(saved) as { day: number; spentUsd: number };
            this.#day = day;
            this.#spentToday = spentUsd;
        }
    }

    add(usage: Usage, model: string): void {
        this.#rollDay();
        const price = this.#prices[model];
        if (!price) {
            this.#unpriced.add(model);
            return;
        }
        const tokens =
            (usage.inputTokens * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) * PER_TOKEN;
        const cost = tokens + (usage.webSearches ?? 0) * (price.webSearch ?? 0);
        this.#spentToday += cost;
        this.#spentTotal += cost;
        this.#store?.setMeta(SPEND_KEY, JSON.stringify({ day: this.#day, spentUsd: this.#spentToday }));
    }

    overBudget(): boolean {
        this.#rollDay();
        return this.#spentToday >= this.#dailyBudgetUsd;
    }

    summary(): { spentTodayUsd: number; spentTotalUsd: number; dailyBudgetUsd: number; unpricedModels: string[] } {
        this.#rollDay();
        return {
            spentTodayUsd: this.#spentToday,
            spentTotalUsd: this.#spentTotal,
            dailyBudgetUsd: this.#dailyBudgetUsd,
            unpricedModels: [...this.#unpriced],
        };
    }

    #rollDay(): void {
        const day = Math.floor(this.#clock.now() / DAY_MS);
        if (day === this.#day) return;
        this.#day = day;
        this.#spentToday = 0;
    }
}

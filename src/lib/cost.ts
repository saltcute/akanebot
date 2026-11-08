import { z } from "zod";
import type { Usage } from "../llm/backend.ts";
import type { Clock } from "./clock.ts";

/** Dollars per million tokens. */
export const pricesSchema = z.record(
    z.string(),
    z.strictObject({ input: z.number().min(0), cachedInput: z.number().min(0), output: z.number().min(0) }),
);
export type Prices = z.infer<typeof pricesSchema>;

const DAY_MS = 86_400_000;
const PER_TOKEN = 1 / 1_000_000;

/** Tracks spend per UTC day. An approximation, for capping and comparing, not for accounting. */
export class CostMeter {
    #clock: Clock;
    #prices: Prices;
    #dailyBudgetUsd: number;
    #day = -1;
    #spentToday = 0;
    #spentTotal = 0;
    #unpriced = new Set<string>();

    constructor(options: { clock: Clock; prices: Prices; dailyBudgetUsd: number }) {
        this.#clock = options.clock;
        this.#prices = options.prices;
        this.#dailyBudgetUsd = options.dailyBudgetUsd;
    }

    add(usage: Usage, model: string): void {
        this.#rollDay();
        const price = this.#prices[model];
        if (!price) {
            this.#unpriced.add(model);
            return;
        }
        const cost = (usage.inputTokens * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) * PER_TOKEN;
        this.#spentToday += cost;
        this.#spentTotal += cost;
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

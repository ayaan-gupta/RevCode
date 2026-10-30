/**
 * Model prices, for showing what a session cost and enforcing `--max-cost`.
 *
 * Prices are US dollars per million tokens at each provider's published
 * pay-as-you-go rate. They are estimates: providers change prices, and on a
 * subscription plan (e.g. Z.ai's GLM Coding Plan) they measure usage, not a bill.
 * Users can add or override any model in config:
 *
 *   "pricing": { "my-model": { "input": 0.5, "output": 1.5, "cachedInput": 0.05 } }
 *
 * When a provider reports the cost of a call itself (OpenRouter does), that wins.
 */

import type { LlmUsage } from "./client.js";

export interface ModelPrice {
  /** $ per 1M uncached input tokens. */
  input: number;
  /** $ per 1M output tokens. */
  output: number;
  /** $ per 1M input tokens served from the prompt cache (default: 10% of input). */
  cachedInput?: number;
  /** $ per 1M input tokens written to the prompt cache (default: 125% of input). */
  cacheWrite?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/** Published list prices for the models RevCode is most often used with. */
export const BUILTIN_PRICES: PriceTable = {
  // Anthropic (first-party API)
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Z.ai
  "glm-5.2": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  // OpenAI
  "gpt-5.5": { input: 5, output: 30, cachedInput: 0.5 },
};

/** Providers that run on the user's own machine cost nothing per token. */
const FREE_PROVIDERS = new Set(["ollama", "local-test"]);

/**
 * The price for a model, or undefined when it is unknown. Matches the exact id,
 * an id with a date suffix (`claude-haiku-4-5-20251001`), and OpenRouter-style
 * `vendor/model` ids by their model part.
 */
export function priceFor(model: string, provider: string, overrides: PriceTable = {}): ModelPrice | undefined {
  if (FREE_PROVIDERS.has(provider)) {
    return { input: 0, output: 0, cachedInput: 0, cacheWrite: 0 };
  }
  const candidates = [model];
  const slash = model.lastIndexOf("/");
  if (slash !== -1) candidates.push(model.slice(slash + 1));
  for (const table of [overrides, BUILTIN_PRICES]) {
    for (const id of candidates) {
      const hit = lookup(table, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

function lookup(table: PriceTable, id: string): ModelPrice | undefined {
  if (Object.hasOwn(table, id)) return table[id];
  const lower = id.toLowerCase();
  for (const [key, price] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (lower === k) return price;
    // Dated snapshots: "<id>-20251001" or Vertex-style "<id>@20251001".
    if (lower.startsWith(k) && /^[-@]\d{8}$/.test(lower.slice(k.length))) return price;
  }
  return undefined;
}

/** Dollar cost of one call's usage. */
export function costOf(usage: LlmUsage, price: ModelPrice): number {
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const written = Math.max(0, usage.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, usage.inputTokens - cached - written);
  const cachedRate = price.cachedInput ?? price.input * 0.1;
  const writeRate = price.cacheWrite ?? price.input * 1.25;
  return (fresh * price.input + cached * cachedRate + written * writeRate + Math.max(0, usage.outputTokens) * price.output) / 1_000_000;
}

/** "$0.04", "$1.27", "<$0.01". */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** Validate a user-supplied price table (config). Returns the good entries and any problems. */
export function validatePriceTable(raw: unknown): { table: PriceTable; problems: string[] } {
  const problems: string[] = [];
  const table: PriceTable = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { table, problems: ['"pricing" must be an object of model → { input, output } in $ per million tokens'] };
  }
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    const num = (key: string): number | undefined => {
      const v = entry?.[key];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const input = num("input");
    const output = num("output");
    if (!entry || typeof entry !== "object" || input === undefined || output === undefined) {
      problems.push(`"pricing.${model}" needs numeric "input" and "output" ($ per million tokens)`);
      continue;
    }
    const price: ModelPrice = { input, output };
    const cachedInput = num("cachedInput");
    const cacheWrite = num("cacheWrite");
    if (cachedInput !== undefined) price.cachedInput = cachedInput;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    table[model] = price;
  }
  return { table, problems };
}

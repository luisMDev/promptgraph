import type { TokenUsage } from "./run.js";

/** USD per million tokens. Cache writes are priced as multiples of input (5m: 1.25x, 1h: 2x). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/** First-party API list prices (cached 2026-10). Keys are canonical model ids. */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** CLI aliases → canonical ids. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/** Resolves aliases, strips date suffixes / context suffixes like "[1m]", and returns the price or undefined. */
export function priceFor(model: string | null | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const base = model.trim().toLowerCase().replace(/\[.*\]$/, "").replace(/^anthropic\./, "");
  const id = MODEL_ALIASES[base] ?? base;
  if (PRICE_TABLE[id]) return PRICE_TABLE[id];
  // Longest known id that prefixes the given one (e.g. dated snapshots).
  const match = Object.keys(PRICE_TABLE)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICE_TABLE[match] : undefined;
}

/** `message.usage` as written in Claude Code transcript assistant lines and `-p --output-format json`. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/**
 * Estimated USD cost of one API response. Without a 5m/1h breakdown, cache writes are priced as 1h
 * (what Claude Code uses). Unknown model → 0.
 */
export function costFromUsage(model: string | null | undefined, usage: RawUsage): number {
  const price = priceFor(model);
  if (!price) return 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  const writeCost =
    w5 !== undefined || w1 !== undefined
      ? (w5 ?? 0) * price.input * CACHE_WRITE_5M + (w1 ?? 0) * price.input * CACHE_WRITE_1H
      : created * price.input * CACHE_WRITE_1H;
  const total =
    (usage.input_tokens ?? 0) * price.input +
    (usage.output_tokens ?? 0) * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    writeCost;
  return total / 1_000_000;
}

export function emptyUsage(model: string | null = null): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, model };
}

/** Adds one raw API usage record (with its model) to an accumulated TokenUsage. */
export function accumulateUsage(acc: TokenUsage, model: string | null | undefined, raw: RawUsage): TokenUsage {
  return {
    inputTokens: acc.inputTokens + (raw.input_tokens ?? 0),
    outputTokens: acc.outputTokens + (raw.output_tokens ?? 0),
    cacheCreationTokens: acc.cacheCreationTokens + (raw.cache_creation_input_tokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (raw.cache_read_input_tokens ?? 0),
    costUsd: acc.costUsd + costFromUsage(model, raw),
    model: model ?? acc.model,
  };
}

/** Sums usages (e.g. run total). `model` is kept only if all inputs agree. */
export function sumUsage(items: readonly TokenUsage[]): TokenUsage {
  const models = new Set(items.map((u) => u.model).filter((m): m is string => !!m));
  return items.reduce<TokenUsage>(
    (a, u) => ({
      inputTokens: a.inputTokens + u.inputTokens,
      outputTokens: a.outputTokens + u.outputTokens,
      cacheCreationTokens: a.cacheCreationTokens + u.cacheCreationTokens,
      cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
      costUsd: a.costUsd + u.costUsd,
      model: a.model,
    }),
    emptyUsage(models.size === 1 ? [...models][0]! : null),
  );
}

export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

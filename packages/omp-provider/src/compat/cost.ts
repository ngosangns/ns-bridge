/**
 * `calculateCost` as exported by @earendil-works/pi-ai 1.0. OMP moved it to
 * `@oh-my-pi/pi-catalog/models`; reimplemented here (pure) so the bundle does
 * not depend on a second OMP package or its legacy shim.
 */

interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostTier extends CostRates {
  inputTokensAbove: number;
}

export interface CostModel {
  cost?: Partial<CostRates> & { tiers?: CostTier[] };
}

export interface CostUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  [key: string]: unknown;
}

export function calculateCost(model: CostModel, usage: CostUsage): CostUsage["cost"] {
  const base: CostRates = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    cacheRead: model.cost?.cacheRead ?? 0,
    cacheWrite: model.cost?.cacheWrite ?? 0,
  };
  const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  let rates: CostRates = base;
  let matchedThreshold = -1;
  for (const tier of model.cost?.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = (usage.cacheWrite ?? 0) - longWrite;
  if (!usage.cost) usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  usage.cost.input = (rates.input / 1_000_000) * (usage.input ?? 0);
  usage.cost.output = (rates.output / 1_000_000) * (usage.output ?? 0);
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * (usage.cacheRead ?? 0);
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

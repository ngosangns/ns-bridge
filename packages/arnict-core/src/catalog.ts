// ABOUTME: The Arnict model catalog contract: bootstrap ids, defaults, and the on-disk cache shape.
// ABOUTME: Hosts read the file; `ns-bridge models refresh arnict --apply` writes it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompactionBudget, compactionBudget } from "ns-core-utils";

/** The provider id whose catalog file this contract describes. */
export const ARNICT_CATALOG_PROVIDER_ID = "arnict";

/** File name the catalog cache writes inside a host's cache directory. */
export const ARNICT_CATALOG_FILE = `${ARNICT_CATALOG_PROVIDER_ID}.models.json`;

/**
 * Environment override for the cache directory a host reads the catalog from.
 *
 * The CLI writes the file wherever the host that owns the refresh keeps its
 * cache; this lets a host point at that directory without hard-coding another
 * host's layout.
 */
export const ARNICT_CATALOG_CACHE_DIR_ENV = "NS_ARNICT_CATALOG_CACHE_DIR";

/** USD per 1M tokens. */
export interface ArnictRates {
  input: number;
  cachedInput: number;
  output: number;
}

/** One model as a host lists and resolves it. */
export interface ArnictModelSpec {
  id: string;
  name: string;
  /**
   * The standard window hosts run and compact inside. For GLM-5.3 ids this is
   * the smaller of the two windows, the vendor's own agentic context — see
   * `ARNICT_GLM_STANDARD_CONTEXT_WINDOW`; `nativeContextWindow` is the larger
   * window Arnict actually serves.
   */
  contextWindow: number;
  /**
   * The window Arnict serves the id against — what the usage ledger records
   * context fill against. Equal to `contextWindow` unless the model carries a
   * standard-window policy.
   */
  nativeContextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  /**
   * Published price in USD per 1M tokens. Absent for a model Arnict has not
   * published rates for, so usage cost stays 0 instead of guessing.
   */
  rates?: ArnictRates;
  /**
   * Where compaction should trigger for this model, derived from its window and
   * completion ceiling. Absent when those two numbers cannot make a budget.
   * Hosts read it; the refresh is what writes it.
   */
  compaction?: CompactionBudget;
}

/**
 * Whether `id` is a GLM 5.3 variant: the family prefix `zai/glm-5.3` on its own
 * or followed by a `-`, `.`, `:`, or `/` separator and any suffix. Arnict lists
 * fresh variants under the prefix (flashx, beta cuts) before this table learns
 * each one, and every id the prefix covers shares the family's windows and
 * output ceiling. A near miss like `zai/glm-5.30` is a different model and does
 * not match.
 */
export function isArnictGlm53Id(id: string): boolean {
  return /^zai\/glm-5\.3(?:[-.:/].*)?$/i.test(id);
}

/**
 * Where every id matching {@link isArnictGlm53Id} should compact, in input
 * tokens: the standard window hosts see for those ids, against the native
 * window Arnict actually serves.
 *
 * The facts behind the choice:
 *
 * - Arnict serves both GLM models with a 1,048,576-token window, 131,072 max
 *   output, flat per-token rates with no long-context tier; cached input is
 *   still billed: flash $0.125 in / $0.05 cached / $0.50 out, glm-5.3 $1.25 /
 *   $0.30 / $2.25 per 1M (arnict.com/docs/pricing, 2026-10-25).
 * - Z.ai's own host ZCode
 *   (/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json,
 *   rule modelMatch ".*glm-5\\.3.*": contextWindow 1000000, maxOutputTokens
 *   128000) auto-compacts at contextWindow - min(maxOutputTokens, 21000) -
 *   13000 (glm/zcode.cjs getAutoCompactThreshold: reserve cap 21000,
 *   bufferTokens 13000) = 966,000. That is window-driven, not cost-driven.
 * - Z.ai runs its own agentic coding evaluations of GLM-5.3 at a 400K context
 *   (DeepSWE "400K context", Terminal-Bench 3.0 "400K context") and HLE with
 *   tools at 300K with context management (z.ai/blog/glm-5.3); only ALE runs
 *   at 1M.
 * - Z.ai's API also bills GLM flat with cached input charged
 *   (docs.z.ai/guides/overview/pricing: GLM-5.3 $1.4/$0.26/$4.4).
 * - Cost: with cached input billed per token, a warm turn's cached-context
 *   cost grows linearly with context: at Arnict rates the cached part of one
 *   turn is context x cachedRate, e.g. flash 383,616 tokens = $0.0192 vs
 *   1,032,192 = $0.0516; glm-5.3 $0.1151 vs $0.3097. A session that compacts
 *   at T averages about T/2 context, so compacting near 384K instead of
 *   ~1.03M cuts the per-session cached-context spend by about 2.7x (arithmetic
 *   from published rates; assumes high cache hit).
 *
 * No price cliff forces the stop — both vendors bill flat — so the number is
 * Z.ai's own agentic evaluation context. Hosts compact via the entry's
 * `compaction` budget: 400,000 with the shared 16,384 reserve triggers at
 * 383,616.
 */
export const ARNICT_GLM_STANDARD_CONTEXT_WINDOW = 400_000;

/**
 * Models known as of 2026-10-25, from arnict.com/models and arnict.com/docs/pricing.
 * The live `/v1/models` list stays the source of truth for what exists; this table
 * only adds names, windows, and rates a bare id list does not carry.
 *
 * `contextWindow` is the standard window from `ARNICT_GLM_STANDARD_CONTEXT_WINDOW`
 * because both ids match `isArnictGlm53Id`; `nativeContextWindow` is the window
 * Arnict actually serves.
 */
export const ARNICT_KNOWN_MODELS: ArnictModelSpec[] = [
  {
    id: "zai/glm-5.3-flash-uncensored",
    name: "GLM 5.3 Flash Abliterated",
    contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
    nativeContextWindow: 1_048_576,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text", "image"],
    rates: { input: 0.125, cachedInput: 0.05, output: 0.5 },
  },
  {
    id: "zai/glm-5.3-uncensored",
    name: "GLM 5.3 Abliterated",
    contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
    nativeContextWindow: 1_048_576,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
    rates: { input: 1.25, cachedInput: 0.3, output: 2.25 },
  },
];

/**
 * Context window assumed for an id the catalog does not know (a fresh
 * `/v1/models` listing this package has not mapped yet).
 */
export const ARNICT_DEFAULT_CONTEXT_WINDOW = 262_144;
/** Output ceiling assumed when the catalog omits one. */
export const ARNICT_DEFAULT_MAX_TOKENS = 32_768;

/** The model a host falls back to when a request names none. */
export const ARNICT_DEFAULT_MODEL_ID = "zai/glm-5.3-flash-uncensored";

const knownById = new Map(ARNICT_KNOWN_MODELS.map((model) => [model.id, model]));

/**
 * The standard GLM 5.3 shape for an id the table does not know: the family's
 * standard and native windows, its published output ceiling, reasoning on,
 * text-only input, and no rates, so cost stays 0.
 */
function glm53Spec(id: string, name: string): ArnictModelSpec {
  return {
    id,
    name,
    contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
    nativeContextWindow: 1_048_576,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
  };
}

/**
 * The window Arnict serves `id` against: the published spec's native window for
 * a known id, the family native window for an unknown id matching
 * `isArnictGlm53Id`, and the default window for anything else.
 *
 * The usage ledger records this as the turn's context window, so context fill
 * reads against what the vendor can actually fill rather than the smaller
 * standard window hosts compact inside.
 */
export function arnictNativeContextWindow(id: string): number {
  return knownById.get(id)?.nativeContextWindow ?? (isArnictGlm53Id(id) ? 1_048_576 : ARNICT_DEFAULT_CONTEXT_WINDOW);
}

/**
 * Attach the compaction budget an entry's window and ceiling imply.
 *
 * Arnict bills flat per token with no long-context tier and publishes no
 * compaction guidance, so the budget comes from the shared ns-core-utils
 * formula rather than any vendor figure (like withGrokCompaction).
 */
export function withArnictCompaction<T extends { contextWindow: number; maxTokens: number }>(model: T): T {
  const budget = compactionBudget(model);
  return budget ? { ...model, compaction: budget } : model;
}

/**
 * The spec for a known id, the GLM 5.3 shape for an unknown id matching
 * `isArnictGlm53Id`, or a default-shaped spec otherwise.
 */
export function arnictModelSpec(id: string): ArnictModelSpec {
  const known = knownById.get(id);
  if (known) return withArnictCompaction(known);
  if (isArnictGlm53Id(id)) return withArnictCompaction(glm53Spec(id, id));
  return withArnictCompaction({
    id,
    name: id,
    contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
    nativeContextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: ARNICT_DEFAULT_MAX_TOKENS,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
  });
}

/** The bootstrap list, for a host that has no catalog file yet. */
export function arnictBootstrapModels(): ArnictModelSpec[] {
  return ARNICT_KNOWN_MODELS.map((model) => withArnictCompaction(model));
}

/**
 * Turn a live `/v1/models` id list into specs. Known ids keep their published
 * spec; unknown ids matching `isArnictGlm53Id` get the GLM 5.3 shape; the rest
 * get the default shape with no rates, so cost stays 0 rather than guessing.
 * An empty list falls back to the bootstrap models.
 */
export function arnictModelsFromModelIds(ids: string[]): ArnictModelSpec[] {
  const seen = new Set<string>();
  const models: ArnictModelSpec[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    models.push(arnictModelSpec(id));
  }
  return models.length > 0 ? models : arnictBootstrapModels();
}

/** The on-disk snapshot shape the catalog cache writes. */
export interface ArnictCatalogSnapshot {
  version?: string;
  etag?: string;
  fetchedAt?: number;
  models?: unknown;
}

/**
 * Parse a catalog file body.
 *
 * `fetchedAt` is deliberately ignored: an expired snapshot is still the list to
 * show, and the refresh is what makes it fresh. A missing, empty, or corrupt
 * body falls back to the bootstrap list rather than an empty picker.
 *
 * Rates never come from the file: a known id keeps its published rates, and an
 * unknown id gets none, so a stale or wrong file cannot invent a price.
 *
 * The window policy is recomputed by id the same way: a known id keeps its
 * published standard and native windows whatever the file says, an unknown id
 * matching `isArnictGlm53Id` keeps the family's windows, output ceiling,
 * reasoning flag, and text-only input whatever the file says (still with no
 * rates), and any other unknown id keeps whatever window the file reports as
 * both of its own.
 */
export function arnictModelsFromCatalogJson(raw: string | undefined): ArnictModelSpec[] {
  if (!raw?.trim()) return arnictBootstrapModels();
  try {
    const parsed = JSON.parse(raw) as ArnictCatalogSnapshot;
    if (!Array.isArray(parsed?.models)) return arnictBootstrapModels();
    const models: ArnictModelSpec[] = [];
    for (const entry of parsed.models) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      const name = typeof row.name === "string" && row.name.length > 0 ? row.name : row.id;
      const known = knownById.get(row.id);
      if (!known && isArnictGlm53Id(row.id)) {
        models.push(withArnictCompaction(glm53Spec(row.id, name)));
        continue;
      }
      const input = Array.isArray(row.input)
        ? row.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
        : (["text"] as Array<"text" | "image">);
      const contextWindow =
        known?.contextWindow ??
        (typeof row.contextWindow === "number" ? row.contextWindow : ARNICT_DEFAULT_CONTEXT_WINDOW);
      models.push(
        withArnictCompaction({
          id: row.id,
          name,
          contextWindow,
          nativeContextWindow: known?.nativeContextWindow ?? contextWindow,
          maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : ARNICT_DEFAULT_MAX_TOKENS,
          reasoning: row.reasoning === true,
          input: input.length > 0 ? input : ["text"],
          rates: known?.rates,
        }),
      );
    }
    return models.length > 0 ? models : arnictBootstrapModels();
  } catch {
    return arnictBootstrapModels();
  }
}

/** Where a host's catalog file lives, given that host's cache directory. */
export function arnictCatalogPath(cacheDir: string): string {
  return join(cacheDir, ARNICT_CATALOG_FILE);
}

/**
 * Read a host's catalog file. A missing or unreadable file is a bootstrap list,
 * not an error: the picker must still open on a machine that never refreshed.
 */
export function readArnictCatalog(options: {
  cacheDir: string;
  readFile?: (path: string) => string;
}): ArnictModelSpec[] {
  const path = arnictCatalogPath(options.cacheDir);
  try {
    const read = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
    return arnictModelsFromCatalogJson(read(path));
  } catch {
    return arnictModelsFromCatalogJson(undefined);
  }
}

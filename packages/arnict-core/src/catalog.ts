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
  contextWindow: number;
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
 * Models known as of 2026-10-25, from arnict.com/models and arnict.com/docs/pricing.
 * The live `/v1/models` list stays the source of truth for what exists; this table
 * only adds names, windows, and rates a bare id list does not carry.
 */
export const ARNICT_KNOWN_MODELS: ArnictModelSpec[] = [
  {
    id: "zai/glm-5.3-flash-uncensored",
    name: "GLM 5.3 Flash Abliterated",
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text", "image"],
    rates: { input: 0.125, cachedInput: 0.05, output: 0.5 },
  },
  {
    id: "zai/glm-5.3-uncensored",
    name: "GLM 5.3 Abliterated",
    contextWindow: 1_048_576,
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

/** The spec for a known id, or a default-shaped spec for one the table does not know. */
export function arnictModelSpec(id: string): ArnictModelSpec {
  const known = knownById.get(id);
  if (known) return withArnictCompaction(known);
  return withArnictCompaction({
    id,
    name: id,
    contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
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
 * spec; the rest get the default shape with no rates, so cost stays 0 rather
 * than guessing. An empty list falls back to the bootstrap models.
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
      const input = Array.isArray(row.input)
        ? row.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
        : (["text"] as Array<"text" | "image">);
      models.push(
        withArnictCompaction({
          id: row.id,
          name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
          contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : ARNICT_DEFAULT_CONTEXT_WINDOW,
          maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : ARNICT_DEFAULT_MAX_TOKENS,
          reasoning: row.reasoning === true,
          input: input.length > 0 ? input : ["text"],
          rates: knownById.get(row.id)?.rates,
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

// ABOUTME: The Grok model catalog contract: bootstrap ids, defaults, and the on-disk cache shape.
// ABOUTME: Hosts read the file; `ns-bridge models refresh grok --apply` writes it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ids `grok models` printed when this list was last checked. A cold cache still
 * shows them, so a host that has never refreshed is not left with an empty
 * picker.
 */
export const GROK_BOOTSTRAP_MODEL_IDS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"] as const;

/**
 * Context window every Grok model is assumed to have when the catalog omits one.
 *
 * This is the window the live model serves (`context_window` in the CLI's
 * models cache: 256k for grok-4.7). The larger figure in `context_windows` is
 * a ceiling, not what a request gets, so a fallback built on it lets a host
 * send prompts the proxy refuses and compact far too late.
 */
export const GROK_DEFAULT_CONTEXT_WINDOW = 256_000;
/** Output ceiling assumed when the catalog omits one. */
export const GROK_DEFAULT_MAX_TOKENS = 128_000;

/** The provider id whose catalog file this contract describes. */
export const GROK_CATALOG_PROVIDER_ID = "grok";

/**
 * The model a host falls back to when a request names none. It is the id
 * `grok models` marks as default.
 */
export const GROK_DEFAULT_MODEL_ID = "grok-4.5";

/** File name the catalog cache writes inside a host's cache directory. */
export const GROK_CATALOG_FILE = `${GROK_CATALOG_PROVIDER_ID}.models.json`;

/**
 * Environment override for the cache directory a host reads the catalog from.
 *
 * The CLI writes the file wherever the host that owns the refresh keeps its
 * cache; this lets a host point at that directory without hard-coding another
 * host's layout.
 */
export const GROK_CATALOG_CACHE_DIR_ENV = "NS_GROK_CATALOG_CACHE_DIR";

/** One model as a host lists and resolves it. */
export interface GrokModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
}

/** The on-disk snapshot shape the catalog cache writes. */
export interface GrokCatalogSnapshot {
  version?: string;
  etag?: string;
  fetchedAt?: number;
  models?: unknown;
}

/** The bootstrap list, for a host that has no catalog file yet. */
export function grokBootstrapModels(): GrokModelSpec[] {
  return GROK_BOOTSTRAP_MODEL_IDS.map((id) => ({
    id,
    name: id,
    contextWindow: GROK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: GROK_DEFAULT_MAX_TOKENS,
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
  }));
}

/**
 * Parse a catalog file body.
 *
 * `fetchedAt` is deliberately ignored: an expired snapshot is still the list to
 * show, and the refresh is what makes it fresh. A missing, empty, or corrupt
 * body falls back to the bootstrap list rather than an empty picker.
 */
export function grokModelsFromCatalogJson(raw: string | undefined): GrokModelSpec[] {
  if (!raw?.trim()) return grokBootstrapModels();
  try {
    const parsed = JSON.parse(raw) as GrokCatalogSnapshot;
    if (!Array.isArray(parsed?.models)) return grokBootstrapModels();
    const models: GrokModelSpec[] = [];
    for (const entry of parsed.models) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      const input = Array.isArray(row.input)
        ? row.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
        : (["text"] as Array<"text" | "image">);
      models.push({
        id: row.id,
        name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
        contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : GROK_DEFAULT_CONTEXT_WINDOW,
        maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : GROK_DEFAULT_MAX_TOKENS,
        reasoning: row.reasoning !== false,
        input: input.length > 0 ? input : ["text"],
      });
    }
    return models.length > 0 ? models : grokBootstrapModels();
  } catch {
    return grokBootstrapModels();
  }
}

/** Where a host's catalog file lives, given that host's cache directory. */
export function grokCatalogPath(cacheDir: string): string {
  return join(cacheDir, GROK_CATALOG_FILE);
}

/**
 * Read a host's catalog file. A missing or unreadable file is a bootstrap list,
 * not an error: the picker must still open on a machine that never refreshed.
 */
export function readGrokCatalog(options: { cacheDir: string; readFile?: (path: string) => string }): GrokModelSpec[] {
  const path = grokCatalogPath(options.cacheDir);
  try {
    const read = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
    return grokModelsFromCatalogJson(read(path));
  } catch {
    return grokModelsFromCatalogJson(undefined);
  }
}

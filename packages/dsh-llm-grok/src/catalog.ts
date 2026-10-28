/**
 * Grok model list for the harness picker.
 *
 * The catalog contract — bootstrap ids, defaults, and the file shape — lives in
 * `ns-grok-core`, so this adapter and the Pi provider cannot disagree about a
 * model. Only the directory is host-specific: `ns-bridge models refresh grok`
 * writes the file under the Pi cache root, and the harness reads it
 * from there. A machine that never refreshed falls back to the bootstrap list.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  GROK_BOOTSTRAP_MODEL_IDS,
  GROK_CATALOG_CACHE_DIR_ENV,
  GROK_DEFAULT_CONTEXT_WINDOW,
  GROK_DEFAULT_MAX_TOKENS,
  type GrokModelSpec,
  grokModelsFromCatalogJson,
  readGrokCatalog,
} from "ns-grok-core";

/** Re-exported so a consumer of this adapter sees the same ids the core publishes. */
export const GROK_BOOTSTRAP_IDS = GROK_BOOTSTRAP_MODEL_IDS;

export type GrokListedModel = GrokModelSpec;

/**
 * The cache root `ns-bridge models refresh` writes into. It is the Pi provider's
 * directory because that is the one the CLI owns; the harness only reads it.
 * `NS_GROK_CATALOG_CACHE_DIR` points a deployment at a different one.
 */
export function grokCatalogCacheDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GROK_CATALOG_CACHE_DIR_ENV]?.trim();
  if (override) return override;
  return join(home, ".pi", "agent", "cache", "ns-pi-provider");
}

/** Parse a catalog file body. Kept as a named export for the adapter's tests. */
export function modelsFromCatalogJson(raw: string | undefined): GrokListedModel[] {
  return grokModelsFromCatalogJson(raw);
}

/** Read the catalog file, falling back to the bootstrap list. */
export function readGrokCatalogFile(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}): GrokListedModel[] {
  return readGrokCatalog({
    cacheDir: grokCatalogCacheDir(options?.home, options?.env),
    ...(options?.readFile ? { readFile: options.readFile } : {}),
  });
}

export { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS };

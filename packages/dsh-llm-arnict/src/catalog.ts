/**
 * Arnict model list for the harness picker.
 *
 * The catalog contract — bootstrap ids, defaults, and the file shape — lives in
 * `ns-arnict-core`, so this adapter and the Pi provider cannot disagree about a
 * model. Only the directory is host-specific: `ns-bridge models refresh arnict`
 * writes the file under the Pi cache root, and the harness reads it
 * from there. A machine that never refreshed falls back to the bootstrap list.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  ARNICT_CATALOG_CACHE_DIR_ENV,
  ARNICT_DEFAULT_CONTEXT_WINDOW,
  ARNICT_DEFAULT_MAX_TOKENS,
  ARNICT_KNOWN_MODELS,
  type ArnictModelSpec,
  arnictModelsFromCatalogJson,
  readArnictCatalog,
} from "ns-arnict-core";

/** Re-exported so a consumer of this adapter sees the same ids the core publishes. */
export const ARNICT_BOOTSTRAP_IDS = ARNICT_KNOWN_MODELS.map((model) => model.id);

export type ArnictListedModel = ArnictModelSpec;

/**
 * The cache root `ns-bridge models refresh` writes into. It is the Pi provider's
 * directory because that is the one the CLI owns; the harness only reads it.
 * `NS_ARNICT_CATALOG_CACHE_DIR` points a deployment at a different one.
 */
export function arnictCatalogCacheDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ARNICT_CATALOG_CACHE_DIR_ENV]?.trim();
  if (override) return override;
  return join(home, ".pi", "agent", "cache", "ns-pi-provider");
}

/** Parse a catalog file body. Kept as a named export for the adapter's tests. */
export function modelsFromCatalogJson(raw: string | undefined): ArnictListedModel[] {
  return arnictModelsFromCatalogJson(raw);
}

/** Read the catalog file, falling back to the bootstrap list. */
export function readArnictCatalogFile(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}): ArnictListedModel[] {
  return readArnictCatalog({
    cacheDir: arnictCatalogCacheDir(options?.home, options?.env),
    ...(options?.readFile ? { readFile: options.readFile } : {}),
  });
}

export { ARNICT_DEFAULT_CONTEXT_WINDOW, ARNICT_DEFAULT_MAX_TOKENS };

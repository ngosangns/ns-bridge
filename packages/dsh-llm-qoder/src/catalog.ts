import { homedir } from "node:os";
import { join } from "node:path";
import {
  QODER_CATALOG_CACHE_DIR_ENV,
  QODER_CATALOG_FILE,
  type QoderModelSpec,
  qoderModelsFromCatalogJson,
  readQoderCatalog,
} from "ns-qoder-core";

export type QoderListedModel = QoderModelSpec;

export function readQoderCatalogFile(home = homedir(), env: NodeJS.ProcessEnv = process.env): QoderListedModel[] {
  const override = env[QODER_CATALOG_CACHE_DIR_ENV]?.trim();
  const cacheDir = override || join(home, ".pi", "agent", "cache", "ns-pi-provider");
  return readQoderCatalog({ cacheDir });
}

export function modelsFromCatalogJson(raw: string): QoderListedModel[] {
  return qoderModelsFromCatalogJson(raw);
}

export { QODER_CATALOG_FILE };

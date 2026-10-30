// ABOUTME: Qoder model catalog contract and bootstrap tiers.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompactionBudget } from "ns-core-utils";
import { compactionBudget } from "ns-core-utils";

export const QODER_CATALOG_PROVIDER_ID = "qoder";
export const QODER_CATALOG_FILE = `${QODER_CATALOG_PROVIDER_ID}.models.json`;
export const QODER_CATALOG_CACHE_DIR_ENV = "NS_QODER_CATALOG_CACHE_DIR";

export const QODER_DEFAULT_MODEL_ID = "auto";
export const QODER_DEFAULT_CONTEXT_WINDOW = 200_000;
export const QODER_DEFAULT_MAX_TOKENS = 16_384;

export interface QoderModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  compaction?: CompactionBudget;
  efforts?: readonly string[];
}

const BOOTSTRAP_IDS = [
  "auto",
  "ultimate",
  "fast",
  "efficient",
  "smodel",
  "cmodel",
  "qmodel_38max",
  "qfmodel",
  "kmodel_latest",
  "kmodel",
  "gmodel",
  "gfmodel",
  "dmodel",
  "dfmodel",
  "mmodel",
] as const;

/**
 * The model server serves bare ids with no display name, so pickers would show
 * "cmodel" and "qmodel_38max". These are the labels the Qoder app itself shows
 * for each id (its modelSelector texts, en locale, 2026-10-30). An id the table
 * misses falls back to the raw id.
 */
const QODER_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  auto: "Auto",
  ultimate: "Ultimate",
  fast: "Fast",
  efficient: "Efficient",
  smodel: "Sonus",
  cmodel: "Cantus",
  qmodel: "Qwen3.7-Plus",
  "qmodel_38max": "Qwen3.8-Max",
  "qmodel_latest": "Qwen3.7-Max",
  "qmodel_preview": "Qwen3.8-Max-Preview",
  q35model: "Qwen3.5-Plus",
  q35model_preview: "Qwen3.7-Max-DogFooding",
  qfmodel: "Qwen3.8-Flash",
  kmodel: "Kimi-K2.8-Preview",
  "kmodel_latest": "Kimi-K3.1-Pro",
  gmodel: "GLM-5.3",
  gfmodel: "GLM-5.3-Flash",
  gm51model: "GLM-5.2",
  dmodel: "DeepSeek-V4-Pro",
  dfmodel: "DeepSeek-Flash",
  mmodel: "MiniMax-M3.1-Flash",
};

/**
 * The cold-start list: ids with the app's display names. Windows, image input and
 * efforts are the server's to say, so a host that never refreshed shows the shared
 * defaults rather than capabilities nobody checked.
 */
export function qoderBootstrapModels(): QoderModelSpec[] {
  return BOOTSTRAP_IDS.map((value) => qoderModelFromInfo({ value, isEnabled: true }));
}

export interface QoderCatalogSnapshot {
  version: string;
  fetchedAt: number;
  models: QoderModelSpec[];
}

export function qoderCatalogPath(cacheDir: string): string {
  return join(cacheDir, QODER_CATALOG_FILE);
}

export function readQoderCatalog(options: { cacheDir: string }): QoderModelSpec[] {
  try {
    const raw = readFileSync(qoderCatalogPath(options.cacheDir), "utf8");
    const parsed = JSON.parse(raw) as QoderCatalogSnapshot;
    if (!parsed?.models?.length) return qoderBootstrapModels();
    return parsed.models;
  } catch {
    return qoderBootstrapModels();
  }
}

export function qoderModelsFromCatalogJson(raw: string): QoderModelSpec[] {
  const parsed = JSON.parse(raw) as QoderCatalogSnapshot;
  if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return qoderBootstrapModels();
  return parsed.models;
}

/** The `ModelInfo` fields the catalog uses. Structural, so this file stays free of the SDK. */
export interface QoderModelInfoFields {
  value: string;
  displayName?: string;
  isEnabled?: boolean;
  isReasoning?: boolean;
  isVl?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  defaultContextWindow?: number;
  efforts?: string[];
}

/** Lowest to highest. An effort the server adds later sorts after these, in the order it listed. */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * One server entry as a spec. Every field comes from the entry: Qoder serves a
 * default window tier next to the largest input it accepts, and a request gets the tier,
 * so the window is the smaller of the two. A field the server leaves out falls
 * back to the shared default.
 */
export function qoderModelFromInfo(info: QoderModelInfoFields): QoderModelSpec {
  const efforts = (Array.isArray(info.efforts) ? info.efforts : [])
    .filter((effort): effort is string => typeof effort === "string" && effort.length > 0)
    .sort((a, b) => {
      const rank = (effort: string) => {
        const index = EFFORT_ORDER.indexOf(effort);
        return index === -1 ? EFFORT_ORDER.length : index;
      };
      return rank(a) - rank(b);
    });
  const tier = positive(info.defaultContextWindow) ? info.defaultContextWindow : undefined;
  const maxInput = positive(info.maxInputTokens) ? info.maxInputTokens : undefined;
  const base: QoderModelSpec = {
    id: info.value,
    name: info.displayName ?? QODER_MODEL_DISPLAY_NAMES[info.value] ?? info.value,
    reasoning: info.isReasoning === true || efforts.length > 0,
    input: info.isVl === true ? ["text", "image"] : ["text"],
    contextWindow:
      tier !== undefined && maxInput !== undefined
        ? Math.min(tier, maxInput)
        : (tier ?? maxInput ?? QODER_DEFAULT_CONTEXT_WINDOW),
    maxTokens: positive(info.maxOutputTokens) ? info.maxOutputTokens : QODER_DEFAULT_MAX_TOKENS,
    ...(efforts.length > 0 ? { efforts } : {}),
  };
  const compaction = compactionBudget(base);
  return compaction ? { ...base, compaction } : base;
}

/** The enabled entries of a server list. An empty list keeps the bootstrap seed, so a host never shows an empty picker. */
export function qoderModelsFromModelInfos(models: readonly QoderModelInfoFields[]): QoderModelSpec[] {
  const out = models.filter((model) => model.isEnabled).map(qoderModelFromInfo);
  return out.length > 0 ? out : qoderBootstrapModels();
}

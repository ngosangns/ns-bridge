/**
 * Grok model list for the harness picker.
 *
 * Pi writes `~/.pi/agent/cache/ns-pi-provider/grok.models.json`. A file past
 * the 15-minute TTL is still the list to show. A missing, empty, or corrupt
 * file uses the same four ids the CLI last printed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_BOOTSTRAP_IDS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"] as const;

const DEFAULT_CONTEXT_WINDOW = 500_000;
const DEFAULT_MAX_TOKENS = 128_000;

export interface GrokListedModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
}

function bootstrapModels(): GrokListedModel[] {
  return GROK_BOOTSTRAP_IDS.map((id) => ({
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
    input: ["text"],
  }));
}

export function grokModelsCachePath(home = homedir()): string {
  return join(home, ".pi", "agent", "cache", "ns-pi-provider", "grok.models.json");
}

/** Parse a catalog file. `fetchedAt` is ignored, so an expired snapshot still lists. */
export function modelsFromCatalogJson(raw: string | undefined): GrokListedModel[] {
  if (!raw?.trim()) return bootstrapModels();
  try {
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed?.models)) return bootstrapModels();
    const models: GrokListedModel[] = [];
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
        contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : DEFAULT_CONTEXT_WINDOW,
        maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : DEFAULT_MAX_TOKENS,
        reasoning: row.reasoning !== false,
        input: input.length > 0 ? input : ["text"],
      });
    }
    return models.length > 0 ? models : bootstrapModels();
  } catch {
    return bootstrapModels();
  }
}

export function readGrokCatalog(options?: { home?: string; readFile?: (path: string) => string }): GrokListedModel[] {
  const path = grokModelsCachePath(options?.home);
  try {
    const read = options?.readFile ?? ((file: string) => readFileSync(file, "utf8"));
    return modelsFromCatalogJson(read(path));
  } catch {
    return modelsFromCatalogJson(undefined);
  }
}

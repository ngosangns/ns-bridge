// ABOUTME: Discovering the Grok CLI's model list.
// ABOUTME: Host-neutral: returns descriptors, not any host's provider-model shape.

import { execFile } from "node:child_process";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS } from "../catalog.js";
import { resolveGrokBinary } from "./binary.js";
import type { GrokModelDescriptor } from "./types.js";

/** What the CLI's own model cache says about one model. A field it leaves out stays undefined. */
export interface GrokCacheInfo {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoningEffort?: boolean;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * What the CLI's own model cache (`~/.grok/models_cache.json`) records for each
 * model: display name, context window, output ceiling and whether it takes a
 * reasoning effort.
 *
 * `grok models` prints only ids, and every model there was assumed to have the
 * same window, name and capabilities. The cache disagrees: it records the window
 * in use (`context_window`) separately from the ceiling (`context_windows`). A
 * host compacts against the window it is handed, so the ceiling would let a
 * prompt through that the proxy then rejects. `max_completion_tokens` is null
 * today, so the output ceiling stays the default until the CLI sets one.
 */
export function grokModelInfoFromCache(raw: string | undefined): Map<string, GrokCacheInfo> {
  const out = new Map<string, GrokCacheInfo>();
  if (!raw?.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as { models?: unknown };
    const models = parsed?.models;
    if (!models || typeof models !== "object") return out;
    for (const [id, entry] of Object.entries(models)) {
      const info = (entry as { info?: Record<string, unknown> } | null)?.info;
      if (!info || typeof info !== "object") continue;
      out.set(id, {
        ...(typeof info.name === "string" && info.name.length > 0 ? { name: info.name } : {}),
        ...(positiveInteger(info.context_window) ? { contextWindow: info.context_window } : {}),
        ...(positiveInteger(info.max_completion_tokens) ? { maxTokens: info.max_completion_tokens } : {}),
        ...(typeof info.supports_reasoning_effort === "boolean"
          ? { supportsReasoningEffort: info.supports_reasoning_effort }
          : {}),
      });
    }
  } catch {
    // A cache the CLI is mid-write is unusable, not fatal: the caller keeps its defaults.
  }
  return out;
}

/** Parse the bullet list `grok models` prints. */
export function parseGrokModelsOutput(
  stdout: string,
  cache?: ReadonlyMap<string, GrokCacheInfo>,
): GrokModelDescriptor[] {
  const models: GrokModelDescriptor[] = [];
  const seen = new Set<string>();

  // Lines like: "  * grok-4.5 (default)" or "  * grok-4.5"
  const bullet = /^\s*[*•-]\s+(\S+)/;
  // "Default model: grok-4.5"
  const defaultLine = /default model:\s*(\S+)/i;

  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(bullet);
    if (m) {
      const id = m[1].replace(/[(),]+$/g, "");
      if (!seen.has(id)) {
        seen.add(id);
        models.push(describe(id, cache));
      }
      continue;
    }
    const d = line.match(defaultLine);
    if (d && !seen.has(d[1])) {
      seen.add(d[1]);
      models.unshift(describe(d[1], cache));
    }
  }

  return models;
}

/** One listed model. The cache says what it knows; a model the cache lacks keeps the defaults. */
function describe(id: string, cache?: ReadonlyMap<string, GrokCacheInfo>): GrokModelDescriptor {
  const info = cache?.get(id);
  return {
    id,
    name: info?.name ?? id,
    contextWindow: info?.contextWindow ?? GROK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: info?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
    supportsReasoningEffort: info?.supportsReasoningEffort ?? true,
  };
}

/** Ask the CLI for its model list, falling back to the bootstrap descriptors. */
export async function discoverGrokModels(
  binary?: string,
  cache?: ReadonlyMap<string, GrokCacheInfo>,
): Promise<{
  models: GrokModelDescriptor[];
  source: "live" | "fallback";
  error?: string;
}> {
  try {
    const bin = binary ?? (await resolveGrokBinary());
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["models"], { encoding: "utf8", timeout: 20_000 }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });
    const parsed = parseGrokModelsOutput(stdout, cache);
    if (parsed.length === 0) {
      return { models: [], source: "fallback", error: "empty model list from CLI" };
    }
    return { models: parsed, source: "live" };
  } catch (err) {
    return {
      models: [],
      source: "fallback",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

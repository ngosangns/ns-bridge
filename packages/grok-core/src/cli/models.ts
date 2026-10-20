// ABOUTME: Discovering the Grok CLI's model list.
// ABOUTME: Host-neutral: returns descriptors, not any host's provider-model shape.

import { execFile } from "node:child_process";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS } from "../catalog.js";
import { resolveGrokBinary } from "./binary.js";
import type { GrokModelDescriptor } from "./types.js";

/**
 * The context window each model is actually using, read from the CLI's own
 * model cache (`~/.grok/models_cache.json`).
 *
 * `grok models` prints only ids, and every model there was assumed to have the
 * same window. The cache disagrees: it records the window in use
 * (`context_window`) separately from the ceiling (`context_windows`). A host
 * compacts against the window it is handed, so the ceiling would let a prompt
 * through that the proxy then rejects.
 */
export function grokContextWindowsFromCache(raw: string | undefined): Map<string, number> {
  const windows = new Map<string, number>();
  if (!raw?.trim()) return windows;
  try {
    const parsed = JSON.parse(raw) as { models?: unknown };
    const models = parsed?.models;
    if (!models || typeof models !== "object") return windows;
    for (const [id, entry] of Object.entries(models)) {
      const info = (entry as { info?: unknown } | null)?.info;
      const window = (info as { context_window?: unknown } | null)?.context_window;
      if (typeof window === "number" && Number.isInteger(window) && window > 0) windows.set(id, window);
    }
  } catch {
    // A cache the CLI is mid-write is unusable, not fatal: the caller keeps its default.
  }
  return windows;
}

/** Parse the bullet list `grok models` prints. */
export function parseGrokModelsOutput(
  stdout: string,
  contextWindows?: ReadonlyMap<string, number>,
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
        models.push(describe(id, contextWindows));
      }
      continue;
    }
    const d = line.match(defaultLine);
    if (d && !seen.has(d[1])) {
      seen.add(d[1]);
      models.unshift(describe(d[1], contextWindows));
    }
  }

  return models;
}

/** One listed model. The cache names its window; a model the cache lacks keeps the default. */
function describe(id: string, contextWindows?: ReadonlyMap<string, number>): GrokModelDescriptor {
  return {
    id,
    name: id,
    contextWindow: contextWindows?.get(id) ?? GROK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: GROK_DEFAULT_MAX_TOKENS,
    supportsReasoningEffort: true,
  };
}

/** Ask the CLI for its model list, falling back to the bootstrap descriptors. */
export async function discoverGrokModels(
  binary?: string,
  contextWindows?: ReadonlyMap<string, number>,
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
    const parsed = parseGrokModelsOutput(stdout, contextWindows);
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

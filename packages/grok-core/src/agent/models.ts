// ABOUTME: Discovering the Grok agent CLI's model list and mapping host model ids onto it.
// ABOUTME: Host-neutral: returns descriptors, not any host's provider-model shape.

import { execFile } from "node:child_process";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS, GROK_DEFAULT_MODEL_ID } from "../catalog.js";
import { resolveGrokBinary } from "./binary.js";
import type { GrokModelDescriptor } from "./types.js";

/** Parse the bullet list `grok models` prints. */
export function parseGrokModelsOutput(stdout: string): GrokModelDescriptor[] {
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
        models.push({
          id,
          name: id,
          contextWindow: GROK_DEFAULT_CONTEXT_WINDOW,
          maxTokens: GROK_DEFAULT_MAX_TOKENS,
          supportsReasoningEffort: true,
        });
      }
      continue;
    }
    const d = line.match(defaultLine);
    if (d && !seen.has(d[1])) {
      seen.add(d[1]);
      models.unshift({
        id: d[1],
        name: d[1],
        contextWindow: GROK_DEFAULT_CONTEXT_WINDOW,
        maxTokens: GROK_DEFAULT_MAX_TOKENS,
        supportsReasoningEffort: true,
      });
    }
  }

  return models;
}

/** Ask the CLI for its model list, falling back to the bootstrap descriptors. */
export async function discoverGrokModels(binary?: string): Promise<{
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
    const parsed = parseGrokModelsOutput(stdout);
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

/**
 * Map a host model id onto a CLI `--model` id.
 * Supports the pre-0.2 alias `grok-4.5-agent` and a generic `*-agent` suffix strip.
 */
export function resolveCliModelId(modelId: string): string {
  if (modelId === "grok-4.5-agent") return GROK_DEFAULT_MODEL_ID;
  if (modelId.endsWith("-agent") && modelId.length > 6) {
    return modelId.slice(0, -"-agent".length);
  }
  return modelId;
}

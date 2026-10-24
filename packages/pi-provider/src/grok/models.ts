// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
/**
 * The Pi half of Grok model handling: the CLI's list becomes Pi provider models.
 *
 * Discovery, id mapping, and the bootstrap list are the core's
 * (`ns-grok-core/cli` and `ns-grok-core`); only the Pi provider-model shape is
 * built here.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { grokBootstrapModels } from "ns-grok-core";
import { discoverGrokModels, type GrokModelDescriptor, grokContextWindowsFromCache } from "ns-grok-core/cli";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, THINKING_LEVEL_MAP } from "./config.js";

export { parseGrokModelsOutput } from "ns-grok-core/cli";

/**
 * Ids `grok models` printed when this list was last checked. The list itself is
 * the core's, so a host that never refreshed and a host that did cannot drift.
 */
export function fallbackModels(): GrokModelDescriptor[] {
  return grokBootstrapModels().map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsReasoningEffort: model.reasoning,
  }));
}

/**
 * Ask the CLI for its models, falling back to the bootstrap descriptors.
 *
 * `contextCache` is the CLI's model cache. It carries the context window each
 * model is using, which `grok models` itself does not print, so a host that
 * compacts has a real limit instead of the shared default.
 */
export async function discoverModels(
  binary?: string,
  contextCache?: string,
): Promise<{
  models: GrokModelDescriptor[];
  source: "live" | "fallback";
  error?: string;
}> {
  const discovered = await discoverGrokModels(binary, grokContextWindowsFromCache(contextCache));
  if (discovered.source === "live") return discovered;
  return { ...discovered, models: fallbackModels() };
}

function toProviderModel(d: GrokModelDescriptor): ProviderModelConfig {
  return {
    id: d.id,
    name: d.name,
    reasoning: true,
    thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: d.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: d.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export function toProviderModels(descriptors: readonly GrokModelDescriptor[]): ProviderModelConfig[] {
  return descriptors.map(toProviderModel);
}

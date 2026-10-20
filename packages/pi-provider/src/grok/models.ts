// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
/**
 * The Pi half of Grok model handling: the CLI's list becomes Pi provider models.
 *
 * Discovery, id mapping, and the bootstrap list are the core's
 * (`ns-grok-core/agent` and `ns-grok-core`); only the Pi provider-model shape is
 * built here.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { grokBootstrapModels } from "ns-grok-core";
import { discoverGrokModels, type GrokModelDescriptor, resolveCliModelId } from "ns-grok-core/agent";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MODEL_ID, THINKING_LEVEL_MAP } from "./config.js";

export { parseGrokModelsOutput, resolveCliModelId } from "ns-grok-core/agent";

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

/** Ask the CLI for its models, falling back to the bootstrap descriptors. */
export function discoverModels(binary?: string): {
	models: GrokModelDescriptor[];
	source: "live" | "fallback";
	error?: string;
} {
	const discovered = discoverGrokModels(binary);
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
	const models = descriptors.map(toProviderModel);
	// Back-compat alias used by older settings / README (v0.1.x).
	const hasDefault = models.some((m) => m.id === DEFAULT_MODEL_ID);
	const hasLegacyAlias = models.some((m) => m.id === "grok-4.5-agent");
	if (hasDefault && !hasLegacyAlias) {
		const base = models.find((m) => m.id === DEFAULT_MODEL_ID)!;
		models.push({
			...base,
			id: "grok-4.5-agent",
			name: `${base.name} (legacy alias)`,
		});
	}
	return models;
}

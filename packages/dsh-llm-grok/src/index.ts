/**
 * Grok adapter plugin for the DeepSeek Harness LLM seam.
 *
 * The model list is the catalog Pi stores for the local `grok` CLI. Streaming
 * spawns that CLI for one turn and maps Anthropic Messages NDJSON onto harness
 * chunks. Tool approval stays with the harness.
 *
 * ```yaml
 * - id: llm-grok
 *   name: 'ns-dsh-llm-grok'
 *   config:
 *     provider: grok
 * ```
 *
 * @module dsh-llm-grok
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { GrokAdapter } from "./adapter.js";

export { GrokAdapter, type GrokAdapterOptions } from "./adapter.js";
export { modelsFromCatalogJson, readGrokCatalog } from "./catalog.js";

export const name = "llm-grok";

export const inject = ["llm"];

export interface Config {
  /** Provider route to register the adapter under. */
  provider: string;
  /** Display name for selectors and status labels. */
  displayName: string;
}

export const Config: z<Config> = z.object({
  provider: z.string().default("grok").description("Provider route to register the adapter under."),
  displayName: z.string().default("Grok").description("Display name shown in model selectors."),
});

export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(
    [config.provider],
    new GrokAdapter({ provider: config.provider, displayName: config.displayName }),
  );
}

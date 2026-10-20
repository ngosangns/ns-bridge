/**
 * Grok adapter plugin for the DeepSeek Harness LLM seam.
 *
 * The model list is the catalog Pi stores for the local `grok` CLI. Streaming
 * calls the CLI chat proxy with that login session. Tool approval stays with
 * the harness.
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
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { createGrokAdapter } from "./adapter.js";

export { createGrokAdapter, type GrokAdapterOptions } from "./adapter.js";
export { modelsFromCatalogJson, readGrokCatalogFile } from "./catalog.js";

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
  // Held here rather than read per request: a deployment without the attachment
  // service never mounts it, and reading an uninjected service throws. The
  // scoped fiber below sets it while the service exists and clears it when the
  // service goes away, so an image-capable deployment gains image support
  // without a text-only one failing to boot.
  let attachments: AttachmentStore | undefined;
  ctx.inject(["attachments"], (scope) => {
    attachments = scope.attachments;
    scope.effect(
      () => () => {
        attachments = undefined;
      },
      "dsh-llm-grok attachment store",
    );
  });

  ctx.llm.registerAdapter(
    [config.provider],
    createGrokAdapter({
      provider: config.provider,
      displayName: config.displayName,
      attachments: () => attachments,
    }),
  );
}

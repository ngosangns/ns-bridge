/**
 * Arnict adapter plugin for the DeepSeek Harness LLM seam.
 *
 * The model list is the catalog Pi stores for Arnict. Streaming posts one
 * chat-completions call to api.arnict.com with the stored API key. Tool
 * approval stays with the harness.
 *
 * ```yaml
 * - id: llm-arnict
 *   name: 'ns-dsh-llm-arnict'
 *   config:
 *     provider: arnict
 * ```
 *
 * @module dsh-llm-arnict
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { createArnictAdapter } from "./adapter.js";

export { type ArnictAdapterOptions, createArnictAdapter } from "./adapter.js";
export { modelsFromCatalogJson, readArnictCatalogFile } from "./catalog.js";

export const name = "llm-arnict";

export const inject = ["llm"];

export interface Config {
  /** Provider route to register the adapter under. */
  provider: string;
  /** Display name for selectors and status labels. */
  displayName: string;
}

export const Config: z<Config> = z.object({
  provider: z.string().default("arnict").description("Provider route to register the adapter under."),
  displayName: z.string().default("Arnict").description("Display name shown in model selectors."),
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
      "dsh-llm-arnict attachment store",
    );
  });

  ctx.llm.registerAdapter(
    [config.provider],
    createArnictAdapter({
      provider: config.provider,
      displayName: config.displayName,
      attachments: () => attachments,
    }),
  );
}

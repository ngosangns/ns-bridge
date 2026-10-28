/**
 * Qoder adapter plugin for the DeepSeek Harness LLM seam.
 *
 * ```yaml
 * - id: llm-qoder
 *   name: 'ns-dsh-llm-qoder'
 *   config:
 *     provider: qoder
 * ```
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { createQoderAdapter } from "./adapter.js";

export { createQoderAdapter, type QoderAdapterOptions } from "./adapter.js";
export { modelsFromCatalogJson, readQoderCatalogFile } from "./catalog.js";

export const name = "llm-qoder";
export const inject = ["llm"];

export interface Config {
  provider: string;
  displayName: string;
}

export const Config: z<Config> = z.object({
  provider: z.string().default("qoder").description("Provider route to register the adapter under."),
  displayName: z.string().default("Qoder").description("Display name shown in model selectors."),
});

export function apply(ctx: Context, config: Config): void {
  let attachments: AttachmentStore | undefined;
  ctx.inject(["attachments"], (scope) => {
    attachments = scope.attachments;
    scope.effect(
      () => () => {
        attachments = undefined;
      },
      "dsh-llm-qoder attachment store",
    );
  });

  ctx.llm.registerAdapter(
    [config.provider],
    createQoderAdapter({
      provider: config.provider,
      displayName: config.displayName,
      attachments: () => attachments,
    }),
  );
}

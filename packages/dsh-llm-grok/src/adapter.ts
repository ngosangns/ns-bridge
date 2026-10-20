/**
 * Harness adapter over the Grok CLI login session.
 *
 * `listModels` and `resolveModel` read the catalog file and do not call the
 * network. `stream` posts one Responses request. The harness owns the tool loop.
 */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { toBridgeEffort } from "ns-bridge-core";
import {
  createDshLlmAdapter,
  type DshAdapterModel,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "ns-bridge-core/dsh";
import { streamGrok } from "ns-grok-core";
import { type GrokListedModel, readGrokCatalogFile } from "./catalog.js";
import { toLlmError } from "./errors.js";

export interface GrokAdapterOptions {
  provider: string;
  displayName: string;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

/** Every listed Grok model accepts images. The catalog file stays text-only. */
const INPUT_MODALITIES = ["text", "image"] as const;

/** The reasoning ladder every Grok model exposes. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function toAdapterModel(model: GrokListedModel): DshAdapterModel {
  return {
    id: model.id,
    name: model.name,
    input: INPUT_MODALITIES,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.reasoning ? { efforts: EFFORTS } : {}),
  };
}

/** Build the Harness adapter for the Grok route. */
export function createGrokAdapter(options: GrokAdapterOptions) {
  const spec: DshLlmAdapterSpec<void> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => readGrokCatalogFile().map(toAdapterModel),
    // Grok authenticates from the local CLI session inside the core, so there is
    // no per-request credential to resolve here.
    credentials: async () => undefined,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    stream: (request: DshAdapterRequest) => {
      const tools = request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      }));
      return streamGrok({
        model: request.model,
        messages: request.messages,
        systemPrompt: request.system,
        tools,
        effort: toBridgeEffort(request.reasoningEffort),
        signal: request.signal,
      });
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}

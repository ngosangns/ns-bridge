/**
 * Harness adapter over the Grok CLI login session.
 *
 * `listModels` and `resolveModel` read the catalog file and do not call the
 * network. `stream` posts one Responses request. The harness owns the tool loop.
 */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { toBridgeEffort } from "ns-bridge-core";
import {
  compactionReserveTokens,
  createDshLlmAdapter,
  type DshAdapterModel,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "ns-bridge-core/dsh";
import { GROK_DEFAULT_CONTEXT_WINDOW, streamGrok } from "ns-grok-core";
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

/**
 * Output held back for Harness compaction, when it is below the catalog ceiling.
 *
 * The catalog's own `compaction.reserveTokens` wins, so a refreshed file and
 * the adapter agree. A file written before that field existed falls back to
 * the same formula the refresh uses.
 */
function reserveField(model: { contextWindow: number; maxTokens: number; compaction?: { reserveTokens: number } }): {
  compactionReserveTokens?: number;
} {
  const reserve = model.compaction?.reserveTokens ?? compactionReserveTokens(model);
  return reserve !== undefined && reserve < model.maxTokens ? { compactionReserveTokens: reserve } : {};
}

/** The reasoning ladder every Grok model exposes. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function toAdapterModel(model: GrokListedModel): DshAdapterModel {
  return {
    id: model.id,
    name: model.name,
    input: INPUT_MODALITIES,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // The catalog ceiling is the most one completion may run to. Reporting all
    // of it as reserved output, on top of the Harness headroom, compacts
    // grok-4.7 near 62k of its 256k window. Hold back Pi's 16,384 instead.
    ...reserveField(model),
    ...(model.reasoning ? { efforts: EFFORTS } : {}),
  };
}

/** Build the Harness adapter for the Grok route. */
export function createGrokAdapter(options: GrokAdapterOptions) {
  const spec: DshLlmAdapterSpec<void> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => readGrokCatalogFile().map(toAdapterModel),
    // Read once per request: the catalog file is what names each model's window,
    // and a refresh between turns has to take effect without restarting.
    contextWindow: (model: string) =>
      readGrokCatalogFile().find((candidate) => candidate.id === model)?.contextWindow ?? GROK_DEFAULT_CONTEXT_WINDOW,
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
        contextWindow: request.contextWindow,
        // The Harness session id is stable across every turn, compaction and
        // title call of one session, which is exactly the cache-routing key xAI wants.
        ...(request.sessionId ? { promptCacheKey: String(request.sessionId) } : {}),
        signal: request.signal,
      });
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}

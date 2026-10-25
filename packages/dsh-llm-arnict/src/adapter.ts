/**
 * Harness adapter over the Arnict chat-completions API.
 *
 * `listModels` and `resolveModel` read the catalog file and do not call the
 * network. `stream` posts one chat-completions request with the stored API
 * key. The harness owns the tool loop.
 */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { streamArnict } from "ns-arnict-core";
import { toBridgeEffort } from "ns-bridge-core";
import {
  compactionReserveTokens,
  createDshLlmAdapter,
  type DshAdapterModel,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "ns-bridge-core/dsh";
import { type ArnictListedModel, readArnictCatalogFile } from "./catalog.js";
import { toLlmError } from "./errors.js";

export interface ArnictAdapterOptions {
  provider: string;
  displayName: string;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

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

/** The reasoning ladder every reasoning Arnict model exposes. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function toAdapterModel(model: ArnictListedModel): DshAdapterModel {
  return {
    id: model.id,
    name: model.name,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...reserveField(model),
    ...(model.reasoning ? { efforts: EFFORTS } : {}),
  };
}

/** Build the Harness adapter for the Arnict route. */
export function createArnictAdapter(options: ArnictAdapterOptions) {
  const spec: DshLlmAdapterSpec<void> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => readArnictCatalogFile().map(toAdapterModel),
    // Arnict authenticates from ARNICT_API_KEY or the key file inside the core,
    // so there is no per-request credential to resolve here.
    credentials: async () => undefined,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    stream: (request: DshAdapterRequest) => {
      const tools = request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      }));
      // No contextWindow: the core records the native 1,048,576-token window
      // Arnict serves against, not the standard window the Harness compacts in.
      return streamArnict({
        model: request.model,
        messages: request.messages,
        systemPrompt: request.system,
        tools,
        effort: toBridgeEffort(request.reasoningEffort),
        // The Harness session id is stable across every turn, compaction and
        // title call of one session, which is what the ledger keys a turn on.
        ...(request.sessionId ? { sessionId: String(request.sessionId) } : {}),
        signal: request.signal,
      });
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}

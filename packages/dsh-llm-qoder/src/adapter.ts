import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { BridgeTool } from "ns-bridge-core";
import { toBridgeEffort, withDeclaredToolNames } from "ns-bridge-core";
import {
  compactionReserveTokens,
  createDshLlmAdapter,
  type DshAdapterModel,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "ns-bridge-core/dsh";
import { requireQoderAuth, streamQoder } from "ns-qoder-core";
import { type QoderListedModel, readQoderCatalogFile } from "./catalog.js";
import { toLlmError } from "./errors.js";

export interface QoderAdapterOptions {
  provider: string;
  displayName: string;
  attachments?: () => AttachmentStore | undefined;
}

function reserveField(model: { contextWindow: number; maxTokens: number; compaction?: { reserveTokens: number } }): {
  compactionReserveTokens?: number;
} {
  const reserve = model.compaction?.reserveTokens ?? compactionReserveTokens(model);
  return reserve !== undefined && reserve < model.maxTokens ? { compactionReserveTokens: reserve } : {};
}

/**
 * Tokens `dsh-compaction-basic` subtracts from the reported window by default.
 * A catalog window of 65,536 leaves a negative pressure budget, so the
 * pre-step compact is rejected and the turn is sent whole.
 */
const DSH_COMPACTION_HEADROOM_TOKENS = 65_536;

function dshContextWindow(model: { contextWindow: number; maxTokens: number }): number {
  const pressure = model.contextWindow - model.maxTokens - DSH_COMPACTION_HEADROOM_TOKENS;
  if (pressure > 0) return model.contextWindow;
  return model.contextWindow + DSH_COMPACTION_HEADROOM_TOKENS;
}

function toAdapterModel(model: QoderListedModel): DshAdapterModel {
  return {
    id: model.id,
    name: model.name,
    input: model.input,
    contextWindow: dshContextWindow(model),
    maxTokens: model.maxTokens,
    ...reserveField(model),
    ...(model.reasoning && model.efforts?.length ? { efforts: model.efforts } : {}),
  };
}

export function createQoderAdapter(options: QoderAdapterOptions) {
  const spec: DshLlmAdapterSpec<void> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => readQoderCatalogFile().map(toAdapterModel),
    credentials: async () => {
      requireQoderAuth();
      return undefined;
    },
    ...(options.attachments ? { attachments: options.attachments } : {}),
    stream: (request: DshAdapterRequest) => {
      requireQoderAuth();
      const tools = request.tools?.map((tool: BridgeTool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      }));
      const events = streamQoder({
        model: request.model,
        messages: request.messages,
        systemPrompt: request.system,
        tools,
        effort: toBridgeEffort(request.reasoningEffort),
        ...(request.sessionId ? { sessionId: String(request.sessionId) } : {}),
        signal: request.signal,
      });
      return withDeclaredToolNames(events, request.tools);
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}

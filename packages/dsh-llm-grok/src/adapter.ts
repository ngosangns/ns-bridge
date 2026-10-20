/**
 * Harness adapter over the Grok CLI login session.
 *
 * `listModels` and `resolveModel` read the Pi catalog file and do not call the
 * network. `stream` posts one Responses request. The harness owns the tool loop.
 */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import {
  type GenerateOptions,
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  ReasoningEffortId,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { streamToDsh, toBridgeMessagesFromDsh } from "ns-bridge-core/dsh";
import { toBridgeEffort } from "ns-bridge-core/pi";
import { streamGrok } from "ns-grok-core";
import { type GrokListedModel, readGrokCatalog } from "./catalog.js";
import { toLlmError } from "./errors.js";

export interface GrokAdapterOptions {
  provider: string;
  displayName: string;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

/** Every listed Grok model accepts images. The catalog file stays text-only. */
const INPUT_MODALITIES = ["text", "image"] as const;

const EFFORTS = [
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
] as const;

export class GrokAdapter extends LlmAdapter {
  constructor(private readonly options: GrokAdapterOptions) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog().map((model) => this.describe(provider, model));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = this.catalog().find((candidate) => candidate.id === model);
    if (!known) throw new LlmError(`Unknown Grok model: ${model}`, "UNKNOWN_MODEL");
    return {
      ...this.describe(provider, known),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(known.reasoning
        ? { reasoning: { efforts: EFFORTS.map(([id, name]) => ({ id: ReasoningEffortId(id), name })) } }
        : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      yield* this.streamInner(options);
    } catch (error) {
      throw toLlmError(error);
    }
  }

  private async *streamInner(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const projected = await toBridgeMessagesFromDsh(options.messages, {
      attachments: this.options.attachments?.(),
      signal: options.signal,
    });
    const system = [options.system, projected.system].filter((part) => !!part).join("\n\n") || undefined;
    const tools = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    }));
    yield* streamToDsh(
      streamGrok({
        model: options.model,
        messages: projected.messages,
        systemPrompt: system,
        tools,
        effort: toBridgeEffort(options.reasoningEffort),
        signal: options.signal,
      }),
    );
  }

  private catalog(): GrokListedModel[] {
    return readGrokCatalog();
  }

  private describe(provider: string, model: GrokListedModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...INPUT_MODALITIES],
    };
  }
}

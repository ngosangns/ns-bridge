// ABOUTME: The Harness LLM seam over devin-core, built from the shared dsh adapter factory.

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { createDshLlmAdapter, type DshAdapterRequest, type DshLlmAdapterSpec } from "ns-bridge-core/dsh";
import { type DevinCredentials, type DevinEffort, type DevinTool, getCachedModels, streamDevin } from "ns-devin-core";
import { toLlmError } from "./errors.js";

/** What the plugin resolves per request and freezes for the duration of one call. */
export interface DevinAdapterOptions {
  /** The route this adapter is registered under. */
  provider: string;
  /** Human-readable provider name for selectors and diagnostics. */
  displayName: string;
  /** Resolve the current session; called once per request. */
  credentials: () => Promise<DevinCredentials>;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

/** Build the Harness adapter for the Devin route. */
export function createDevinAdapter(options: DevinAdapterOptions) {
  const spec: DshLlmAdapterSpec<DevinCredentials> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => getCachedModels(),
    credentials: options.credentials,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    stream: (request: DshAdapterRequest, credentials) => {
      const model = getCachedModels().find((candidate) => candidate.id === request.model);
      if (!model) throw new Error(`Unknown Devin model: ${request.model}`);

      const tools: DevinTool[] | undefined = request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

      return streamDevin({
        model,
        messages: request.messages,
        systemPrompt: request.system,
        tools,
        effort: request.reasoningEffort as DevinEffort | undefined,
        apiKey: credentials.access,
        sessionId: request.sessionId,
        signal: request.signal,
      });
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}

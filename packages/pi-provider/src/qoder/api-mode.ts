import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamToPi, toBridgeContext, toBridgeEffort } from "ns-bridge-core/pi";
import { streamQoder } from "ns-qoder-core";

export function streamViaQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamToPi({
    model,
    createStream: createAssistantMessageEventStream,
    signal: options?.signal,
    discardOnReset: true,
    events: () => {
      const neutral = toBridgeContext(context as never);
      return streamQoder({
        model: model.id,
        messages: neutral.messages,
        systemPrompt: neutral.systemPrompt,
        tools: neutral.tools,
        effort: toBridgeEffort(options?.reasoning),
        sessionId: options?.sessionId,
        signal: options?.signal,
      });
    },
  });
}

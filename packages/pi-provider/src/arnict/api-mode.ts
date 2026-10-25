// One chat-completions call per host turn. Pi and OMP keep their harness; Arnict is only the model.
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamArnict } from "ns-arnict-core";
import { streamToPi, toBridgeContext, toBridgeEffort } from "ns-bridge-core/pi";

export function streamViaArnict(
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
      return streamArnict({
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

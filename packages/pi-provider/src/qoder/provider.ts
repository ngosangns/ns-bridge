import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { emptyAssistantMessage } from "../arnict/message.js";
import { streamViaQoder } from "./api-mode.js";

export function streamQoderForPi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  try {
    return streamViaQoder(model, context, options);
  } catch (err) {
    const stream = createAssistantMessageEventStream();
    const output = emptyAssistantMessage(model);
    queueMicrotask(() => {
      output.stopReason = "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      output.content.push({ type: "text", text: output.errorMessage });
      stream.push({ type: "error", reason: "error", error: output });
      stream.end(output);
    });
    return stream;
  }
}

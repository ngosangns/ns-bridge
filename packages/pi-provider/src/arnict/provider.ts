import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamViaArnict } from "./api-mode.js";
import { emptyAssistantMessage } from "./message.js";

/**
 * The registered provider's stream. One chat-completions call per host turn:
 * the Arnict key is the session, and the host runs the tools. Nothing here
 * shells out to a CLI.
 */
export function streamArnictForPi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  try {
    return streamViaArnict(model, context, options);
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

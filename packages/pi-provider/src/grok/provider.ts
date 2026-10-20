// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamViaApi } from "./api-mode.js";
import { emptyAssistantMessage } from "./message.js";

/**
 * The registered provider's stream. One Responses call per host turn: the Grok
 * CLI login is the session, and the host runs the tools. Nothing here spawns
 * the Grok CLI.
 */
export function streamGrokForPi(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	try {
		return streamViaApi(model, context, options);
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

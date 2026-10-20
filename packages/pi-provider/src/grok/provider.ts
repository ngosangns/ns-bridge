// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamViaAcp } from "./acp-mode.js";
import { streamViaApi } from "./api-mode.js";
import { resolveIntegrationMode } from "./config.js";
import { emptyAssistantMessage } from "./events.js";
import { streamViaHost } from "./host-mode.js";
import { streamViaJsonl } from "./jsonl-mode.js";

/**
 * Lazy-friendly entry used by the registered provider.
 * `api` (default) calls the Responses API with the Grok CLI login. The host runs tools.
 * `host` spawns one grok process per turn. `acp` keeps a long-lived Grok agent. `jsonl` is one-shot headless.
 */
export function streamGrokAgent(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	try {
		const mode = resolveIntegrationMode();
		if (mode === "jsonl") return streamViaJsonl(model, context, options);
		if (mode === "acp") return streamViaAcp(model, context, options);
		if (mode === "host") return streamViaHost(model, context, options);
		return streamViaApi(model, context, options);
	} catch (err) {
		// Invalid mode / immediate config failure
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

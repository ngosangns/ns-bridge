// One Responses call per host turn. Pi and OMP keep their harness; Grok is only the model.
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamToPi, toBridgeContext, toBridgeEffort } from "ns-bridge-core/pi";
import { streamGrok } from "ns-grok-core";

export function streamViaApi(
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
			return streamGrok({
				model: model.id,
				messages: neutral.messages,
				systemPrompt: neutral.systemPrompt,
				tools: neutral.tools,
				effort: toBridgeEffort(options?.reasoning),
				...(options?.sessionId ? { promptCacheKey: options.sessionId } : {}),
				signal: options?.signal,
			});
		},
	});
}

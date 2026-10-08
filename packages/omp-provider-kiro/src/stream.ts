// ABOUTME: OMP's streamSimple for Kiro: resolves credentials and the catalog entry, then hands
// ABOUTME: kiro-core's neutral events to the shared Pi-family bridge (ns-bridge-core/pi) for assembly.

import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as PiAi from "@oh-my-pi/pi-ai";
import { streamToPi, toBridgeContext, toBridgeEffort } from "ns-bridge-core/pi";
import {
  formatSafeError,
  getKiroRegionFromEndpoint,
  type KiroModel,
  streamKiro,
  toKiroModelForHost,
} from "ns-kiro-core";
import { resolveRequestCredentials } from "./auth.js";

/** Catalog metadata this provider attaches to the models it registers. */
export type KiroBackedModel = Model<Api> & {
  kiroModelId?: string;
  kiroRegion?: string;
  kiroProfileArn?: string;
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
};

/**
 * pi-ai's barrel re-exports the stream class as type-only ahead of the runtime
 * class, so a named import resolves to a type. Read the constructor off the
 * namespace instead, and fall back to the factory omp still ships for older
 * extensions when the class itself is not exported.
 */
function newEventStream(): AssistantMessageEventStream {
  const runtime = PiAi as unknown as {
    AssistantMessageEventStream?: new () => AssistantMessageEventStream;
    createAssistantMessageEventStream?: () => AssistantMessageEventStream;
  };
  if (typeof runtime.AssistantMessageEventStream === "function") return new runtime.AssistantMessageEventStream();
  if (typeof runtime.createAssistantMessageEventStream === "function") {
    return runtime.createAssistantMessageEventStream();
  }
  throw new Error("This omp build exposes no AssistantMessageEventStream; omp-provider-kiro needs omp >= 18.1.");
}

/** Rebuild the core's model descriptor from what OMP hands back at request time (see kiro-core). */
export function toKiroModel(model: KiroBackedModel, region: string): KiroModel {
  return toKiroModelForHost(model, region);
}

export function streamKiroForOmp(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamToPi({
    model,
    createStream: newEventStream,
    signal: options?.signal,
    formatError: formatSafeError,
    // OMP renders from `partial`, so discarding blocks is a matter of
    // truncating the array the renderer already reads.
    discardOnReset: true,
    events: async () => {
      const hostKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
      const credentials = await resolveRequestCredentials(hostKey);
      const region =
        (model as KiroBackedModel).kiroRegion ?? getKiroRegionFromEndpoint(model.baseUrl) ?? credentials.region;
      const neutral = toBridgeContext(context);
      return streamKiro({
        model: toKiroModel(model as KiroBackedModel, region),
        messages: neutral.messages,
        systemPrompt: neutral.systemPrompt,
        tools: neutral.tools,
        effort: toBridgeEffort(options?.reasoning),
        accessToken: credentials.accessToken,
        sessionId: options?.sessionId,
        signal: options?.signal,
        profileArn: (model as KiroBackedModel).kiroProfileArn ?? credentials.profileArn,
        canDiscardEmittedBlocks: true,
      });
    },
  });
}

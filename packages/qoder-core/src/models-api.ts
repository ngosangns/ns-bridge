// ABOUTME: Fetches the live model list through a short SDK query.
// The query stays idle. No user prompt is written.

import { query, type SDKUserMessage } from "@qoder-ai/qoder-agent-sdk";
import { type ResolvedQoderAuth, requireQoderAuth } from "./auth.js";
import { type QoderModelSpec, qoderModelsFromModelInfos } from "./catalog.js";
import { QoderApiError } from "./errors.js";

export async function fetchQoderModels(
  options: { auth?: ResolvedQoderAuth; signal?: AbortSignal } = {},
): Promise<QoderModelSpec[]> {
  const auth = options.auth ?? requireQoderAuth();
  const idle = new AbortController();
  if (options.signal?.aborted) idle.abort();
  else options.signal?.addEventListener("abort", () => idle.abort(), { once: true });

  const q = query({
    prompt: idlePrompt(idle.signal),
    options: {
      auth: auth.options,
      maxTurns: 1,
      permissionMode: "dontAsk",
      tools: [],
      skills: [],
      includePartialMessages: false,
      persistSession: false,
      ...(options.signal ? { abortController: abortFromSignal(options.signal) } : {}),
    },
  });
  try {
    return qoderModelsFromModelInfos(await q.getAvailableModels());
  } catch (error) {
    throw new QoderApiError(error instanceof Error ? error.message : "Failed to list Qoder models");
  } finally {
    idle.abort();
    try {
      await q.interrupt();
    } catch {
      // The transport may already be closed after getAvailableModels.
    }
  }
}

/** Never yields. `getAvailableModels` does not need a user turn. */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 30_000);
  if (signal.aborted) {
    clearTimeout(timer);
    resolve();
  } else {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  }
  await promise;
}

function abortFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

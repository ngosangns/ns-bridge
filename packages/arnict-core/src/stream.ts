// ABOUTME: One chat-completions call against api.arnict.com using the stored Arnict API key.
// ABOUTME: The host owns the transcript and the tool loop. This client only speaks HTTP.

import { abortableDelay, exponentialBackoff, parseRetryAfterMs, recordUsage } from "ns-core-utils";
import { loadArnictApiKey } from "./auth.js";
import { ArnictApiError, arnictApiErrorFromResponse } from "./errors.js";
import { buildChatCompletionsBody } from "./request.js";
import {
  chatCompletionChunks,
  createChatState,
  finishChat,
  parseSseData,
  reduceChatChunk,
  type WireChatChunk,
  type WireChatCompletion,
} from "./sse.js";
import type { ArnictEffort, ArnictMessage, ArnictStreamEvent, ArnictTool } from "./types.js";

export const ARNICT_BASE_URL_ENV = "ARNICT_BASE_URL";
export const ARNICT_DEFAULT_BASE_URL = "https://api.arnict.com/v1";

/** Base for `/chat/completions` and `/models`: option, then `ARNICT_BASE_URL`, then the default. */
export function arnictBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env[ARNICT_BASE_URL_ENV]?.trim() || ARNICT_DEFAULT_BASE_URL).replace(/\/$/, "");
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

export interface StreamArnictOptions {
  model: string;
  messages: readonly ArnictMessage[];
  systemPrompt?: string;
  tools?: readonly ArnictTool[];
  /**
   * Recorded against the turn in the usage ledger only. Arnict documents no
   * reasoning/effort request parameter, so nothing is sent for it.
   */
  effort?: ArnictEffort;
  contextWindow?: number;
  maxTokens?: number;
  sessionId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Skip the key file. Tests pass a key; production leaves this unset. */
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function aborted(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* eventsFromChunks(
  chunks: AsyncIterable<WireChatChunk> | Iterable<WireChatChunk>,
  requestedModel: string,
  signal?: AbortSignal,
): AsyncGenerator<ArnictStreamEvent> {
  const state = createChatState(requestedModel);
  for await (const chunk of chunks) {
    if (signal?.aborted) throw aborted();
    yield* reduceChatChunk(state, chunk);
  }
  if (signal?.aborted) throw aborted();
  yield* finishChat(state);
}

/** Stream one model turn. Does not run a tool and does not execute tool calls. */
export function streamArnict(options: StreamArnictOptions): AsyncGenerator<ArnictStreamEvent> {
  return recordUsage(streamArnictResponse(options), {
    vendor: "arnict",
    model: options.model,
    contextWindow: options.contextWindow,
    effort: options.effort,
    sessionId: options.sessionId,
  });
}

async function* streamArnictResponse(options: StreamArnictOptions): AsyncGenerator<ArnictStreamEvent> {
  if (options.signal?.aborted) throw aborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? (await loadArnictApiKey()).apiKey;
  const base = (options.baseUrl ?? arnictBaseUrl()).replace(/\/$/, "");
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => abortableDelay(ms, options.signal));
  const body = buildChatCompletionsBody({
    model: options.model,
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: options.tools,
    maxTokens: options.maxTokens,
  });
  // Every retry happens before the first event is yielded; once events reach the
  // caller a failing stream is a thrown error, never a replay.
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (isAbort(error, options.signal)) throw aborted();
      if (attempt >= maxRetries) {
        throw new ArnictApiError(
          `Arnict request failed: ${(error instanceof Error ? error.message : "network error").slice(0, 300)}`,
        );
      }
      await sleep(exponentialBackoff(attempt, RETRY_BASE_MS, RETRY_MAX_MS));
      continue;
    }
    if (!response.ok) {
      const apiError = await arnictApiErrorFromResponse(response, apiKey);
      const retryable = RETRYABLE_STATUSES.has(response.status) && apiError.code !== "insufficient_quota";
      if (!retryable || attempt >= maxRetries) throw apiError;
      await sleep(parseRetryAfterMs(response.headers) ?? exponentialBackoff(attempt, RETRY_BASE_MS, RETRY_MAX_MS));
      continue;
    }
    if (!response.body) throw new ArnictApiError("Arnict error: empty response body");
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
      const completion = (await response.json()) as WireChatCompletion;
      yield* eventsFromChunks(chatCompletionChunks(completion), options.model, options.signal);
      return;
    }
    yield* eventsFromChunks(parseSseData(readBody(response.body)), options.model, options.signal);
    return;
  }
}

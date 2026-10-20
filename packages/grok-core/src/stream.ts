// ABOUTME: One Responses call against cli-chat-proxy using the Grok CLI login session.
// ABOUTME: The host owns the transcript, the tool schemas, and the tool loop. This client only speaks HTTP.

import { loadGrokAccess } from "./auth.js";
import { GrokApiError } from "./errors.js";
import { grokProxyBase, grokResponseHeaders, resolveGrokClientVersion } from "./headers.js";
import { buildResponsesBody, grokWireModelId } from "./request.js";
import { createResponsesState, finishResponses, parseSseJson, reduceResponsesEvent, type WireEvent } from "./sse.js";
import type { GrokEffort, GrokMessage, GrokStreamEvent, GrokTool } from "./types.js";

export interface StreamGrokOptions {
  model: string;
  messages: readonly GrokMessage[];
  systemPrompt?: string;
  tools?: readonly GrokTool[];
  effort?: GrokEffort;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Skip the auth file. Tests pass a token; production leaves this unset. */
  accessToken?: string;
  clientVersion?: string;
  proxyBaseUrl?: string;
  loadAccess?: () => Promise<{ accessToken: string }>;
}

function aborted(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const redact = (value: string) => value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const redacted = redact(text).replace(/\s+/g, " ").trim();
  if (!redacted) return "";
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof json.error === "string" ? json.error : (json.error?.message ?? json.message);
    if (message) return redact(message).slice(0, 300);
  } catch {
    // The proxy sometimes answers with plain text.
  }
  return redacted.slice(0, 300);
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

async function* eventsFromWire(
  events: AsyncIterable<WireEvent> | Iterable<WireEvent>,
  requestedModel: string,
  signal?: AbortSignal,
): AsyncGenerator<GrokStreamEvent> {
  const state = createResponsesState(requestedModel);
  for await (const event of events) {
    if (signal?.aborted) throw aborted();
    yield* reduceResponsesEvent(state, event);
  }
  if (signal?.aborted) throw aborted();
  yield* finishResponses(state);
}

/** Stream one model turn. Does not spawn `grok` and does not run a tool. */
export async function* streamGrok(options: StreamGrokOptions): AsyncGenerator<GrokStreamEvent> {
  if (options.signal?.aborted) throw aborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const access = options.accessToken
    ? { accessToken: options.accessToken }
    : await (options.loadAccess ?? (() => loadGrokAccess({ fetchImpl })))();
  const clientVersion = options.clientVersion ?? (await resolveGrokClientVersion());
  const base = (options.proxyBaseUrl ?? grokProxyBase()).replace(/\/$/, "");
  const body = buildResponsesBody({
    model: options.model,
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: options.tools,
    effort: options.effort,
  });
  const response = await fetchImpl(`${base}/responses`, {
    method: "POST",
    headers: grokResponseHeaders({
      accessToken: access.accessToken,
      clientVersion,
      modelId: options.model,
    }),
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new GrokApiError(`Grok responses error (${response.status})${detail ? `: ${detail}` : ""}`, response.status);
  }
  if (!response.body) throw new GrokApiError("Grok responses error: empty body");
  const contentType = response.headers.get("content-type") ?? "";
  const wireModel = grokWireModelId(options.model);
  if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const json = (await response.json()) as WireEvent["response"];
    yield* eventsFromWire([{ type: "response.completed", response: json }], wireModel, options.signal);
    return;
  }
  yield* eventsFromWire(parseSseJson(readBody(response.body)), wireModel, options.signal);
}

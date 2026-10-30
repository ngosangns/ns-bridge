// ABOUTME: Direct client for the Qoder model server's OpenAI-style SSE wire.
// The host owns the tool loop: this process only streams and reports tool calls.

import { randomUUID } from "node:crypto";
import { recordUsage } from "ns-core-utils";
import { type ResolvedQoderAuth, requireQoderAuth } from "./auth.js";
import { QODER_DEFAULT_CONTEXT_WINDOW, QODER_DEFAULT_MAX_TOKENS, qoderBootstrapModels } from "./catalog.js";
import { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "./errors.js";
import { toQoderWireMessages } from "./prompt.js";
import { createWireReduceState, finishWireReduce, reduceWireChunk } from "./reduce.js";
import { qoderSessionId } from "./session.js";
import type { QoderEffort, QoderMessage, QoderStreamEvent, QoderTool } from "./types.js";

export interface StreamQoderOptions {
  model: string;
  messages: readonly QoderMessage[];
  systemPrompt?: string;
  tools?: readonly QoderTool[];
  effort?: QoderEffort;
  sessionId?: string;
  signal?: AbortSignal;
  cwd?: string;
  auth?: ResolvedQoderAuth;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** Version string the model server's metadata gate expects from the CLI. */
const QODER_WIRE_VERSION = "1.1.81";
const QODER_WIRE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";
const RETRY_DELAYS_MS = [200, 500];

/** CLI's own override for the model server host (`https://<host>/model/v1/...`). */
export function qoderWireUrl(host: string | undefined, endpoint?: string): string {
  const direct = endpoint?.trim();
  if (direct) return direct;
  const override = host?.trim();
  if (override) return `https://${override}/model/v1/chat/completions`;
  return QODER_WIRE_URL;
}

function aborted(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** `minimal`/`xhigh` are bridge spellings; the server only knows `low`..`max`. */
function wireEffort(effort: QoderEffort): string {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "max";
  return effort;
}

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return `${arch}_${process.platform}`;
}

function toWireTool(tool: QoderTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: tool.parameters,
      ...(tool.strict === true ? { strict: true } : {}),
    },
  };
}

interface QoderRequestBody {
  payload: Record<string, unknown>;
  requestId: string;
}

function buildRequestBody(options: StreamQoderOptions, sessionId: string | undefined): QoderRequestBody {
  const requestId = randomUUID();
  const spec = qoderBootstrapModels().find((model) => model.id === options.model);
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: toQoderWireMessages(options.messages, options.systemPrompt),
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: randomUUID(),
        session_id: sessionId,
        task_id: "common",
        client_type: "5",
      },
      // `business` is the gate: without `product: "cli"` the server rejects
      // every model id except `auto`.
      business: {
        product: "cli",
        version: QODER_WIRE_VERSION,
        type: "agent",
        model_key: options.model,
      },
    },
    max_tokens: spec?.maxTokens ?? QODER_DEFAULT_MAX_TOKENS,
    ...(options.tools?.length ? { tools: options.tools.map(toWireTool) } : {}),
    ...(options.effort ? { enable_thinking: true, reasoning_effort: wireEffort(options.effort) } : {}),
  };
  return { payload, requestId };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (error) {
      // Retry only the pre-stream window: once a response exists the caller
      // may already be reading events, and a replay could double-charge.
      if (signal?.aborted || attempt >= RETRY_DELAYS_MS.length) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new QoderApiError(
          `Qoder model server unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await delay(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // body already consumed or unreadable — the status line still stands
  }
  const suffix = detail ? `: ${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    return new QoderAuthError(`${QODER_LOGIN_MESSAGE} (HTTP ${response.status}${suffix})`);
  }
  return new QoderApiError(`Qoder model server returned HTTP ${response.status}${suffix}`);
}

/**
 * JSON payloads from the SSE stream, one per `data:` prefix. The server
 * sometimes emits a raw newline inside a JSON value, so frames cannot be
 * split on line endings: each payload is scanned as one balanced JSON value
 * and `[DONE]` is passed through as the end sentinel.
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pos = 0;
  let collecting = false;
  let valueStart = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (pos < buffer.length) {
      if (!collecting) {
        const index = buffer.indexOf("data:", pos);
        if (index === -1) {
          // Keep a tail so a prefix split across chunks is still found.
          buffer = buffer.slice(Math.max(pos, buffer.length - 5));
          pos = 0;
          break;
        }
        pos = index + 5;
        if (buffer[pos] === " ") pos += 1;
        if (buffer.startsWith("[DONE]", pos)) {
          buffer = buffer.slice(pos + 6);
          pos = 0;
          yield "[DONE]";
          continue;
        }
        collecting = true;
        valueStart = pos;
        depth = 0;
        inString = false;
        escaped = false;
        continue;
      }
      const ch = buffer[pos];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth <= 0) {
          yield buffer.slice(valueStart, pos + 1);
          buffer = buffer.slice(pos + 1);
          pos = 0;
          collecting = false;
          continue;
        }
      }
      pos += 1;
    }
  }
  if (collecting) {
    const tail = buffer.slice(valueStart).trim();
    if (tail) yield tail;
  }
}

async function* streamQoderResponse(options: StreamQoderOptions): AsyncGenerator<QoderStreamEvent> {
  if (options.signal?.aborted) throw aborted();
  const auth = options.auth ?? requireQoderAuth();
  const sessionId = qoderSessionId(options.sessionId);
  const { payload, requestId } = buildRequestBody(options, sessionId);
  if ((payload.messages as unknown[]).length === 0) throw new QoderApiError("Qoder prompt is empty");

  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.token}`,
    "content-type": "application/json",
    "x-request-id": requestId,
    "cosy-clienttype": "5",
    "cosy-machineos": machineOs(),
    "cosy-version": QODER_WIRE_VERSION,
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = qoderWireUrl(process.env.QODER_MODEL_SERVER_HOST, options.endpoint);
  const response = await postWithRetry(fetchImpl, url, headers, JSON.stringify(payload), options.signal);
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new QoderApiError("Qoder model server returned an empty body");

  const state = createWireReduceState();
  try {
    for await (const data of sseData(response.body)) {
      if (options.signal?.aborted) throw aborted();
      if (data === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      for (const event of reduceWireChunk(state, chunk)) yield event;
    }
    for (const event of finishWireReduce(state)) yield event;
  } finally {
    // Leaving early (tool handoff, host abort) must not hold the socket.
    try {
      await response.body.cancel();
    } catch {
      // already closed
    }
  }
}

export function streamQoder(options: StreamQoderOptions): AsyncGenerator<QoderStreamEvent> {
  const contextWindow =
    qoderBootstrapModels().find((model) => model.id === options.model)?.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW;
  return recordUsage(streamQoderResponse(options), {
    vendor: "qoder",
    model: options.model,
    contextWindow,
    effort: options.effort,
    sessionId: options.sessionId,
  });
}

// ABOUTME: Direct client for the Qoder model server's signed agent SSE wire.
// The host owns the tool loop: this process only streams and reports tool calls.

import { randomUUID } from "node:crypto";
import { recordUsage } from "ns-core-utils";
import { qoderConfigDir, type ResolvedQoderAuth, requireQoderAuth } from "./auth.js";
import {
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_DEFAULT_MAX_TOKENS,
  QODER_WIRE_BODY_LIMIT_BYTES,
  qoderBootstrapModels,
} from "./catalog.js";
import { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "./errors.js";
import { toQoderWireMessages } from "./prompt.js";
import { createWireReduceState, finishWireReduce, reduceWireChunk } from "./reduce.js";
import { qoderSessionId } from "./session.js";
import { type QoderSigningIdentity, readQoderSigningIdentity, signQoderInferRequest } from "./store.js";
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

/** Cosy-Version the live qodercli 1.1.83 signer puts on infer requests. */
const QODER_WIRE_VERSION = "1.1.83";
const QODER_INFER_ORIGIN = "https://api2.qoder.sh";
const ANONYMOUS_SIGNING_IDENTITY: QoderSigningIdentity = {
  machineId: "00000000-0000-0000-0000-000000000000",
  userInfoJson: JSON.stringify({ uid: "", encrypt_user_info: "", key: "" }),
};
const RETRY_DELAYS_MS = [200, 500];

/** Inference origin. `prepareInferRequest` rewrites it onto the agent SSE path. */
export function qoderWireUrl(host: string | undefined, endpoint?: string): string {
  const direct = endpoint?.trim();
  if (direct) return originOf(direct);
  const override = host?.trim();
  if (!override) return QODER_INFER_ORIGIN;
  if (override.startsWith("http://") || override.startsWith("https://")) return originOf(override);
  return `https://${override}`;
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
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

/**
 * Estimate the serialized byte size of a Qoder request body.
 * This is a rough approximation used for trimming decisions.
 */
function estimateQoderBodyBytes(payload: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Trim oldest messages from the payload until it fits within the wire body limit.
 * Preserves tool call pairs (assistant with tool_calls + corresponding tool results).
 * Keeps the system message and at least the last user message.
 *
 * Modeled after Grok's `fitResponsesBody()` in packages/grok-core/src/request.ts.
 */
export function fitQoderBody(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = payload.messages as unknown[] | undefined;
  if (!Array.isArray(messages) || messages.length <= 1) return payload;
  if (estimateQoderBodyBytes(payload) <= QODER_WIRE_BODY_LIMIT_BYTES) return payload;

  const kept = messages.slice();
  while (kept.length > 1 && estimateQoderBodyBytes({ ...payload, messages: kept }) > QODER_WIRE_BODY_LIMIT_BYTES) {
    const dropped = kept[0] as { role?: unknown; tool_calls?: unknown[] };
    kept.shift();

    // If we dropped an assistant message with tool_calls, also drop the
    // corresponding tool result messages to keep pairs together.
    if (dropped?.role === "assistant" && Array.isArray(dropped.tool_calls) && dropped.tool_calls.length > 0) {
      const toolCallIds = new Set(
        dropped.tool_calls
          .map((tc) => (tc && typeof tc === "object" && "id" in tc ? (tc as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === "string"),
      );
      // Drop tool result messages that correspond to the dropped tool calls
      while (kept.length > 1) {
        const next = kept[0] as { role?: unknown; tool_call_id?: unknown };
        if (next?.role === "tool" && typeof next.tool_call_id === "string" && toolCallIds.has(next.tool_call_id)) {
          kept.shift();
          toolCallIds.delete(next.tool_call_id);
          if (toolCallIds.size === 0) break;
        } else {
          break;
        }
      }
    }
  }
  return { ...payload, messages: kept };
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

function lastUserText(messages: readonly QoderMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const lines: string[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text) lines.push(part.text);
    }
    if (lines.length > 0) return lines.join("\n");
  }
  return "";
}

function buildRequestBody(options: StreamQoderOptions, sessionId: string | undefined): QoderRequestBody {
  const requestId = randomUUID();
  const spec = qoderBootstrapModels().find((model) => model.id === options.model);
  const text = lastUserText(options.messages);
  const maxTokens = spec?.maxTokens ?? QODER_DEFAULT_MAX_TOKENS;
  const payload: Record<string, unknown> = {
    request_id: requestId,
    chat_record_id: requestId,
    request_set_id: randomUUID(),
    session_id: sessionId,
    source_session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    aliyun_user_type: "",
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: options.model, is_reasoning: spec?.reasoning === true },
        originalContent: text,
      },
      chatPrompt: "",
      imageUrls: null,
    },
    session_type: "qodercli",
    task_id: "common",
    system: options.systemPrompt ?? "",
    messages: toQoderWireMessages(options.messages, options.systemPrompt),
    tools: options.tools?.map(toWireTool) ?? [],
    parameters: {
      max_tokens: maxTokens,
      ...(options.effort ? { enable_thinking: true, reasoning_effort: wireEffort(options.effort) } : {}),
    },
    model_config: {
      key: options.model,
      display_name: spec?.name ?? options.model,
      model: "",
      is_vl: spec?.input.includes("image") === true,
      is_reasoning: spec?.reasoning === true,
      max_input_tokens: spec?.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW,
      source: "system",
      format: "openai",
      api_key: "",
      url: "",
    },
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

/** The agent SSE wraps each OpenAI chunk in `{body, statusCodeValue}`. */
function unwrapWireChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return chunk;
  const record = chunk as Record<string, unknown>;
  if (typeof record.statusCodeValue !== "number" || typeof record.body !== "string") return chunk;
  if (record.statusCodeValue !== 200) {
    let detail = "";
    try {
      const inner = JSON.parse(record.body) as { message?: unknown };
      if (typeof inner.message === "string") detail = inner.message.slice(0, 200);
    } catch {
      // The status line is enough when the envelope body is not JSON.
    }
    const status = typeof record.statusCode === "string" ? record.statusCode : String(record.statusCodeValue);
    throw new QoderApiError(`Qoder model server rejected the request (${status}${detail ? `: ${detail}` : ""})`);
  }
  try {
    return JSON.parse(record.body);
  } catch {
    return undefined;
  }
}

/**
 * Control characters the model server injects into frames when it wraps a long
 * payload. A wrap can land inside a JSON string (`"dfmodel"` → `"d\nfmodel"`),
 * which is invalid JSON and used to make the whole frame get dropped, losing
 * model text and tool-call fragments. Inside a string a raw control character
 * is never legal, and between tokens it is only whitespace, so removing them
 * from the wire text repairs the frame without changing what it means.
 */
const RAW_CONTROL_CHARS = /\p{Cc}/gu;

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
    buffer += decoder.decode(chunk, { stream: true }).replace(RAW_CONTROL_CHARS, "");
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
  if (!auth.token) throw new QoderAuthError(QODER_LOGIN_MESSAGE);
  const sessionId = qoderSessionId(options.sessionId);
  const { payload } = buildRequestBody(options, sessionId);
  if ((payload.messages as unknown[]).length === 0) throw new QoderApiError("Qoder prompt is empty");

  const fetchImpl = options.fetchImpl ?? fetch;
  const fittedPayload = fitQoderBody(payload);
  const body = JSON.stringify(fittedPayload);
  const bodyBytes = Buffer.byteLength(body);
  // The model server answers HTTP 500 with {"error":"internal server error"}
  // for every body over this cap, which a host cannot tell from an outage.
  if (bodyBytes > QODER_WIRE_BODY_LIMIT_BYTES) {
    throw new QoderApiError(
      `Qoder prompt is too long for this model's context window (${bodyBytes} bytes > ${QODER_WIRE_BODY_LIMIT_BYTES} bytes)`,
    );
  }
  const origin = qoderWireUrl(process.env.QODER_MODEL_SERVER_HOST, options.endpoint);
  const identity = readQoderSigningIdentity(qoderConfigDir()) ?? ANONYMOUS_SIGNING_IDENTITY;
  const signed = signQoderInferRequest(origin, body, options.model, "system", identity, QODER_WIRE_VERSION);
  const headers = { ...signed.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "cosy-machineos")) {
    headers["Cosy-MachineOS"] = machineOs();
  }
  const response = await postWithRetry(fetchImpl, signed.url, headers, signed.body, options.signal);
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new QoderApiError("Qoder model server returned an empty body");

  const state = createWireReduceState();
  try {
    for await (const data of sseData(response.body)) {
      if (options.signal?.aborted) throw aborted();
      if (data === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = unwrapWireChunk(JSON.parse(data));
      } catch (error) {
        if (error instanceof QoderApiError) throw error;
        continue;
      }
      if (chunk === undefined) continue;
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

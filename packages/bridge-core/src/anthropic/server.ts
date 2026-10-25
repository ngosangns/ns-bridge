// ABOUTME: Local Anthropic-Messages-compatible HTTP server that hosts like ZCode point their
// ABOUTME: Anthropic client at. One mount per vendor core; translation lives in request/stream.

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { formatErrorMessage } from "../errors.js";
import type { BridgeContext, BridgeEffort, BridgeStreamEvent } from "../types.js";
import { toBridgeRequest } from "./request.js";
import { anthropicError, collectAnthropicMessage, toAnthropicSse } from "./stream.js";

/** One vendor core's neutral surface, as the local server drives it. */
export interface AnthropicBackend {
  listModels(): Array<{ id: string; name?: string }>;
  stream(request: {
    model: string;
    context: BridgeContext;
    effort?: BridgeEffort;
    maxTokens?: number;
    sessionId?: string;
    signal: AbortSignal;
  }): AsyncIterable<BridgeStreamEvent>;
  /** HTTP status for an error thrown before the first event (e.g. 401 for a missing login). */
  errorStatus?(error: unknown): number | undefined;
  formatError?(error: unknown): string;
}

export interface AnthropicServerOptions {
  /** One mount per vendor: the first path segment picks the backend. */
  backends: Record<string, AnthropicBackend>;
  /** When set, every route but /healthz must present it via `x-api-key` or a Bearer token. */
  token?: string;
  log?: (line: string) => void;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

interface RequestMeta {
  vendor?: string;
  model?: string;
  status: number;
}

export function createAnthropicServer(options: AnthropicServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: AnthropicServerOptions): Promise<void> {
  const startedAt = Date.now();
  const meta: RequestMeta = { status: 500 };
  try {
    await route(req, res, options, meta);
  } catch (error) {
    meta.status = 500;
    replyError(res, anthropicError(500, formatErrorMessage(error)));
  } finally {
    const ms = Date.now() - startedAt;
    let line = `${req.method ?? "-"} ${requestUrl(req).pathname} ${meta.status} ${ms}ms`;
    if (meta.vendor !== undefined) line += ` vendor=${meta.vendor}`;
    if (meta.model !== undefined) line += ` model=${meta.model}`;
    options.log?.(line);
  }
}

function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    return new URL("http://localhost/");
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: AnthropicServerOptions,
  meta: RequestMeta,
): Promise<void> {
  const method = req.method ?? "";
  const url = requestUrl(req);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (method === "GET" && segments.length === 1 && segments[0] === "healthz") {
    meta.status = 200;
    replyJson(res, 200, { ok: true, vendors: Object.keys(options.backends) });
    return;
  }

  if (options.token !== undefined && !authorized(req, options.token)) {
    meta.status = 401;
    replyError(res, anthropicError(401, "invalid or missing API key"));
    return;
  }

  const [vendorName, api, resource, extra] = segments;
  const backend =
    vendorName !== undefined && Object.hasOwn(options.backends, vendorName) ? options.backends[vendorName] : undefined;
  if (vendorName !== undefined && api === "v1" && extra === undefined) {
    if (method === "GET" && resource === "models") {
      meta.vendor = vendorName;
      if (!backend) return notFound(res, meta, `unknown vendor ${vendorName}`);
      const data = backend.listModels().map((model) => ({
        type: "model",
        id: model.id,
        display_name: model.name ?? model.id,
        created_at: "1970-01-01T00:00:00Z",
      }));
      meta.status = 200;
      replyJson(res, 200, {
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
      return;
    }
    if (method === "POST" && resource === "messages") {
      meta.vendor = vendorName;
      await handleMessages(req, res, options, vendorName, backend, meta);
      return;
    }
  }

  meta.status = 404;
  replyError(res, anthropicError(404, `unknown route ${method} ${url.pathname}`));
}

function notFound(res: ServerResponse, meta: RequestMeta, message: string): void {
  meta.status = 404;
  replyError(res, anthropicError(404, message));
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: AnthropicServerOptions,
  vendor: string,
  backend: AnthropicBackend | undefined,
  meta: RequestMeta,
): Promise<void> {
  const body = await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (!body.ok) {
    meta.status = body.status;
    replyError(res, anthropicError(body.status, body.message));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body);
  } catch {
    meta.status = 400;
    replyError(res, anthropicError(400, "request body is not valid JSON"));
    return;
  }

  const projected = toBridgeRequest(parsed);
  if ("error" in projected) {
    meta.status = 400;
    replyError(res, anthropicError(400, projected.error));
    return;
  }
  meta.model = projected.model;

  if (!backend) {
    notFound(res, meta, `unknown vendor ${vendor}`);
    return;
  }
  if (!backend.listModels().some((entry) => entry.id === projected.model)) {
    notFound(res, meta, `unknown model ${projected.model} for ${vendor}`);
    return;
  }

  const headerSession = headerValue(req.headers, "x-session-id");
  const sessionId = headerSession ?? sessionFromBody(parsed);

  const controller = new AbortController();
  // A client that hangs up must reach the vendor core; `writableEnded` separates
  // a finished response from one abandoned mid-stream.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  res.on("error", () => {
    controller.abort();
  });

  const peeked = await peekFirst(() =>
    backend.stream({
      model: projected.model,
      context: projected.context,
      ...(projected.effort !== undefined ? { effort: projected.effort } : {}),
      ...(projected.maxTokens !== undefined ? { maxTokens: projected.maxTokens } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      signal: controller.signal,
    }),
  );
  if (!peeked.ok) {
    const error = anthropicError(
      backend.errorStatus?.(peeked.error) ?? 500,
      backend.formatError?.(peeked.error) ?? formatErrorMessage(peeked.error),
    );
    meta.status = error.status;
    replyError(res, error);
    return;
  }
  const { iterator, first } = peeked;

  async function* replay(): AsyncGenerator<BridgeStreamEvent> {
    try {
      if (!first.done) yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  const streamOptions = { model: projected.model, messageId: `msg_${randomUUID().replaceAll("-", "")}` };

  if (!projected.stream) {
    try {
      const message = await collectAnthropicMessage(replay(), streamOptions);
      meta.status = 200;
      replyJson(res, 200, message);
    } catch (error) {
      meta.status = 500;
      replyError(res, anthropicError(500, formatErrorMessage(error)));
    }
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  meta.status = 200;
  try {
    for await (const frame of toAnthropicSse(replay(), streamOptions)) {
      if (controller.signal.aborted || res.destroyed) break;
      if (!res.write(frame)) await drained(res);
    }
    res.end();
  } catch {
    controller.abort();
    res.destroy();
  }
}

/**
 * Pull the first event before any header goes out, so an error thrown before
 * the stream started can still be answered with a real status instead of a
 * half-written 200.
 */
async function peekFirst(
  stream: () => AsyncIterable<BridgeStreamEvent>,
): Promise<
  | { ok: true; iterator: AsyncIterator<BridgeStreamEvent>; first: IteratorResult<BridgeStreamEvent> }
  | { ok: false; error: unknown }
> {
  try {
    const iterator = stream()[Symbol.asyncIterator]();
    return { ok: true, iterator, first: await iterator.next() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ ok: true; body: string } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      // Reply at once and drop the rest; the connection closes after the reply.
      req.resume();
      return { ok: false, status: 413, message: `request body exceeds ${limit} bytes` };
    }
    chunks.push(chunk);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

function authorized(req: IncomingMessage, expected: string): boolean {
  return tokenMatches(expected, headerValue(req.headers, "x-api-key")) || tokenMatches(expected, bearerToken(req));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = headerValue(req.headers, "authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time even on length mismatch: a length leak narrows a brute force. */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fallback when no x-session-id header arrived: a client may tuck the session
 * into `metadata.user_id` as a JSON string carrying a session_id.
 */
function sessionFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const metadata = body.metadata;
  if (!isRecord(metadata) || typeof metadata.user_id !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata.user_id);
    if (typeof parsed === "string") return parsed.length > 0 ? parsed : undefined;
    if (isRecord(parsed) && typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  } catch {
    // Not JSON; there is no session to recover.
  }
  return undefined;
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function replyError(res: ServerResponse, error: ReturnType<typeof anthropicError>): void {
  replyJson(res, error.status, error.body);
}

/** Settle on the socket closing too, so a dead client never wedges the write loop. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once("drain", resolve);
    res.once("close", resolve);
  });
}

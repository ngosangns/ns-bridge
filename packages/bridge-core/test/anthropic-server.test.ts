// ABOUTME: Tests the local Anthropic-Messages HTTP server: auth, routing, SSE streaming,
// ABOUTME: non-streaming replies, error statuses, body limits, and abort propagation.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type AnthropicBackend, createAnthropicServer } from "../src/anthropic/server.js";
import type { BridgeStreamEvent, BridgeUsage } from "../src/types.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(options: Parameters<typeof createAnthropicServer>[0]): Promise<string> {
  const server = createAnthropicServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const USAGE: BridgeUsage = {
  input: 5,
  output: 3,
  totalTokens: 8,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

const API_BODY = {
  model: "claude-fake",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
};

interface RecordedRequest {
  model: string;
  sessionId: string | undefined;
  signal: AbortSignal;
}

type FakeBackend = AnthropicBackend & { requests: RecordedRequest[] };

async function* defaultStream(): AsyncGenerator<BridgeStreamEvent> {
  yield { type: "start" };
  yield { type: "text_start", index: 0 };
  yield { type: "text_delta", index: 0, delta: "Hello" };
  yield { type: "text_end", index: 0, text: "Hello" };
  yield { type: "usage", usage: USAGE };
  yield { type: "done", stopReason: "stop" };
}

function fakeBackend(
  stream: (request: { signal: AbortSignal }) => AsyncIterable<BridgeStreamEvent> = defaultStream,
  models: Array<{ id: string; name?: string }> = [{ id: "claude-fake", name: "Fake Claude" }],
): FakeBackend {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    listModels: () => models,
    stream(request) {
      requests.push({ model: request.model, sessionId: request.sessionId, signal: request.signal });
      return stream(request);
    },
  };
}

interface Frame {
  event: string;
  data: {
    delta?: { stop_reason?: string };
    usage?: Record<string, number>;
    error?: { type?: string; message?: string };
    message?: { usage?: { input_tokens?: number } };
    [key: string]: unknown;
  };
}

function throwingStream(message: string): AsyncIterable<BridgeStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<BridgeStreamEvent>> {
          throw new Error(message);
        },
      };
    },
  };
}

function parseSse(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [eventLine = "", dataLine = ""] = chunk.split("\n");
      return {
        event: eventLine.slice("event: ".length),
        data: JSON.parse(dataLine.slice("data: ".length)) as Frame["data"],
      };
    });
}

function post(base: string, path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

describe("createAnthropicServer", () => {
  it("answers /healthz without auth", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() }, token: "tok" });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, vendors: ["kiro"] });
  });

  it("rejects a request with no token", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() }, token: "tok" });
    const res = await fetch(`${base}/kiro/v1/models`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
  });

  it("rejects a wrong token via x-api-key and Bearer", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() }, token: "tok" });
    const byKey = await fetch(`${base}/kiro/v1/models`, { headers: { "x-api-key": "nope" } });
    expect(byKey.status).toBe(401);
    const byBearer = await fetch(`${base}/kiro/v1/models`, { headers: { authorization: "Bearer nope" } });
    expect(byBearer.status).toBe(401);
  });

  it("accepts the token via x-api-key and Bearer", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() }, token: "tok" });
    const byKey = await fetch(`${base}/kiro/v1/models`, { headers: { "x-api-key": "tok" } });
    expect(byKey.status).toBe(200);
    const byBearer = await fetch(`${base}/kiro/v1/models`, { headers: { authorization: "Bearer tok" } });
    expect(byBearer.status).toBe(200);
  });

  it("lists a vendor's models", async () => {
    const base = await listen({
      backends: { kiro: fakeBackend(defaultStream, [{ id: "a" }, { id: "b", name: "B" }]) },
    });
    const res = await fetch(`${base}/kiro/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { type: "model", id: "a", display_name: "a", created_at: "1970-01-01T00:00:00Z" },
        { type: "model", id: "b", display_name: "B", created_at: "1970-01-01T00:00:00Z" },
      ],
      has_more: false,
      first_id: "a",
      last_id: "b",
    });
  });

  it("streams a response as Anthropic SSE", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() } });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify({ ...API_BODY, stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const frames = parseSse(await res.text());
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[0]?.data.message?.usage?.input_tokens).toBe(0);
    expect(frames[1]?.data.content_block).toEqual({ type: "text", text: "" });
    expect(frames[2]?.data.delta).toEqual({ type: "text_delta", text: "Hello" });
    expect(frames[4]?.data.delta?.stop_reason).toBe("end_turn");
    expect(frames[4]?.data.usage?.input_tokens).toBe(5);
    expect(frames[4]?.data.usage?.output_tokens).toBe(3);
  });

  it("collects a non-streaming message", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() } });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify(API_BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      id: string;
      type: string;
      role: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.id).toMatch(/^msg_/);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-fake");
    expect(body.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it("answers 404 for an unknown vendor and an unknown model", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() } });
    const vendor = await post(base, "/nope/v1/messages", JSON.stringify(API_BODY));
    expect(vendor.status).toBe(404);
    expect(((await vendor.json()) as { error: { message: string } }).error.message).toBe("unknown vendor nope");
    const model = await post(base, "/kiro/v1/messages", JSON.stringify({ ...API_BODY, model: "claude-other" }));
    expect(model.status).toBe(404);
    const body = (await model.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toBe("unknown model claude-other for kiro");
  });

  it("answers 404 for count_tokens and other unmatched routes", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() } });
    const count = await post(base, "/kiro/v1/messages/count_tokens", "{}");
    expect(count.status).toBe(404);
    expect(((await count.json()) as { error: { type: string } }).error.type).toBe("not_found_error");
    const stray = await fetch(`${base}/kiro/nope`);
    expect(stray.status).toBe(404);
  });

  it("answers 400 for invalid JSON and an invalid request", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() } });
    const torn = await post(base, "/kiro/v1/messages", "{nope");
    expect(torn.status).toBe(400);
    expect(((await torn.json()) as { error: { message: string } }).error.message).toBe(
      "request body is not valid JSON",
    );
    const empty = await post(base, "/kiro/v1/messages", JSON.stringify({ model: "claude-fake", messages: [] }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { message: string } }).error.message).toBe(
      "messages must be a non-empty array",
    );
  });

  it("answers 413 over the body limit", async () => {
    const base = await listen({ backends: { kiro: fakeBackend() }, maxBodyBytes: 16 });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify(API_BODY));
    expect(res.status).toBe(413);
  });

  it("maps a pre-stream failure to the backend's status and text", async () => {
    const base = await listen({
      backends: {
        kiro: {
          listModels: () => [{ id: "claude-fake" }],
          stream() {
            return throwingStream("secret wire detail");
          },
          errorStatus: () => 401,
          formatError: () => "login expired",
        },
      },
    });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify({ ...API_BODY, stream: true }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("login expired");
  });

  it("falls back to 500 and the raw message when the backend maps nothing", async () => {
    const base = await listen({
      backends: {
        kiro: {
          listModels: () => [{ id: "claude-fake" }],
          stream() {
            return throwingStream("boom before first event");
          },
        },
      },
    });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify(API_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("boom before first event");
  });

  it("reports a mid-stream failure as an SSE error frame", async () => {
    const base = await listen({
      backends: {
        kiro: fakeBackend(async function* () {
          yield { type: "start" };
          yield { type: "text_start", index: 0 };
          yield { type: "text_delta", index: 0, delta: "part" };
          throw new Error("mid-stream boom");
        }),
      },
    });
    const res = await post(base, "/kiro/v1/messages", JSON.stringify({ ...API_BODY, stream: true }));
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ]);
    const last = frames[frames.length - 1]?.data.error;
    expect(last?.type).toBe("api_error");
    expect(last?.message).toBe("mid-stream boom");
  });

  it("propagates a client hangup to the backend signal", async () => {
    let backendSignal: AbortSignal | undefined;
    let wake = () => {};
    const aborted = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const backend = fakeBackend((request) =>
      (async function* () {
        backendSignal = request.signal;
        yield { type: "start" };
        await new Promise<void>((resume) => {
          request.signal.addEventListener("abort", () => resume(), { once: true });
        });
        wake();
      })(),
    );
    const base = await listen({ backends: { kiro: backend } });
    const controller = new AbortController();
    const res = await fetch(`${base}/kiro/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...API_BODY, stream: true }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    controller.abort();
    await aborted;
    expect(backendSignal?.aborted).toBe(true);
    await reader?.cancel().catch(() => {});
  });

  it("passes x-session-id through and falls back to metadata.user_id", async () => {
    const backend = fakeBackend();
    const base = await listen({ backends: { kiro: backend } });
    await post(base, "/kiro/v1/messages", JSON.stringify(API_BODY), { "x-session-id": "sess-header" });
    await post(
      base,
      "/kiro/v1/messages",
      JSON.stringify({
        ...API_BODY,
        metadata: { user_id: JSON.stringify({ session_id: "sess-metadata" }) },
      }),
    );
    expect(backend.requests.map((request) => request.sessionId)).toEqual(["sess-header", "sess-metadata"]);
  });

  it("logs one line per request with vendor and model", async () => {
    const lines: string[] = [];
    const base = await listen({ backends: { kiro: fakeBackend() }, log: (line) => lines.push(line) });
    await fetch(`${base}/healthz`);
    await post(base, "/kiro/v1/messages", JSON.stringify(API_BODY));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^GET \/healthz 200 \d+ms$/);
    expect(lines[1]).toMatch(/^POST \/kiro\/v1\/messages 200 \d+ms vendor=kiro model=claude-fake$/);
  });
});

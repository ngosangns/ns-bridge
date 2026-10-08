// Differential tests: the same Devin turns, against the same scripted Cascade
// server, through the in-process TypeScript core and the Go sidecar. Events,
// errors and the bytes each engine sends must agree. Skipped without Go.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { SidecarError, sidecarStream } from "ns-bridge-core/sidecar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { streamDevinWithCapacityRetry } from "../src/capacity-retry.js";
import { devinErrorFromSidecar, toDevinSidecarRequest } from "../src/engine.js";
import { DevinApiError, DevinProtocolError, DevinStreamError } from "../src/errors.js";
import {
  AssignModelResponseSchema,
  ChatToolCallSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtResponseSchema,
  ModelAssignmentSchema,
  ModelUsageStatsSchema,
  StopReason,
} from "../src/proto/devin-messages.js";
import { create, fromBinary, toBinary, toJson } from "../src/proto/protobuf.js";
import { type DevinStreamRequest, streamDevin, streamDevinInProcess } from "../src/stream.js";
import type { DevinStreamEvent } from "../src/types.js";
import { buildSidecar, hasGo } from "./helpers/go-sidecar.js";

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: Uint8Array | string;
}

/** What the scripted server answers, per RPC, in call order (last one repeats). */
interface Script {
  jwt?: Reply[];
  assign?: Reply[];
  chat: Reply[];
}

interface Recorded {
  path: string;
  body: Buffer;
}

let server: Server;
let baseUrl = "";
let script: Script = { chat: [] };
let recorded: Recorded[] = [];
let sidecar: { bin: string; cleanup: () => void } | undefined;

function next(list: Reply[] | undefined, path: string, fallback: Reply): Reply {
  const count = recorded.filter((r) => r.path === path).length - 1;
  if (!list || list.length === 0) return fallback;
  return list[Math.min(count, list.length - 1)];
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const jwtOk = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt-1" }));

beforeAll(async () => {
  if (!hasGo) return;
  sidecar = buildSidecar();
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").replace(/^\/edge/, "");
    recorded.push({ path: req.url ?? "", body });
    const reply = path.endsWith("/GetUserJwt")
      ? next(script.jwt, req.url ?? "", { body: jwtOk })
      : path.endsWith("/AssignModel")
        ? next(script.assign, req.url ?? "", { status: 500, body: "no assign scripted" })
        : next(script.chat, req.url ?? "", { status: 500, body: "no chat scripted" });
    res.writeHead(reply.status ?? 200, reply.headers ?? {});
    res.end(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  sidecar?.cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function frame(payload: Uint8Array, flag = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

function msg(
  fields: Parameters<typeof create<typeof GetChatMessageResponseSchema extends never ? never : never>>[1] | object,
) {
  return frame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, fields as never)));
}

function gzMsg(fields: object) {
  return frame(
    gzipSync(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, fields as never))),
    1,
  );
}

function trailer(value: unknown) {
  return frame(new TextEncoder().encode(JSON.stringify(value)), 2);
}

function body(...frames: Uint8Array[]): Uint8Array {
  return Buffer.concat(frames.map((f) => Buffer.from(f)));
}

const model: DevinStreamRequest["model"] = {
  id: "swe-1-6",
  name: "SWE-1.6",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 128_000,
};

type Outcome = { events: unknown[]; error?: unknown; requests: unknown[] };

function describeError(error: unknown) {
  if (error instanceof DevinApiError) return { class: "DevinApiError", message: error.message, status: error.status };
  if (error instanceof DevinStreamError)
    return { class: "DevinStreamError", message: error.message, code: error.code, overflow: error.contextOverflow };
  if (error instanceof DevinProtocolError)
    return { class: "DevinProtocolError", message: error.message, kind: error.kind };
  return { class: "other", message: error instanceof Error ? error.message : String(error) };
}

function normalizeEvents(events: DevinStreamEvent[]): unknown[] {
  return JSON.parse(JSON.stringify(events), (key, value) => (key === "__parseError" ? "<parse error>" : value));
}

function decodeRequests(): unknown[] {
  return recorded.map(({ path, body }) => {
    if (!path.endsWith("/GetChatMessage")) return { path, hex: body.toString("hex") };
    expect(body[0]).toBe(1); // gzip flag
    const decoded = fromBinary(GetChatMessageRequestSchema, gunzipSync(body.subarray(5)));
    const json = toJson(GetChatMessageRequestSchema, decoded) as Record<string, unknown>;
    expect(typeof json.executionId).toBe("string");
    delete json.executionId;
    return { path, json };
  });
}

type Run = (request: DevinStreamRequest, retry?: boolean) => AsyncIterable<DevinStreamEvent>;

const policy = { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 };

const runTs: Run = (request, retry) =>
  retry ? streamDevinWithCapacityRetry(request, policy, streamDevinInProcess) : streamDevinInProcess(request);

const runGo: Run = async function* (request, retry) {
  try {
    yield* sidecarStream("devin", toDevinSidecarRequest(request, retry ? policy : undefined), {
      env: { ...process.env, NS_BRIDGE_BIN: sidecar?.bin },
      stderr: false,
    }) as AsyncIterable<DevinStreamEvent>;
  } catch (error) {
    throw error instanceof SidecarError ? devinErrorFromSidecar(error) : error;
  }
};

async function outcome(run: Run, request: DevinStreamRequest, retry: boolean): Promise<Outcome> {
  recorded = [];
  const events: DevinStreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of run(request, retry)) events.push(event);
  } catch (caught) {
    error = describeError(caught);
  }
  return { events: normalizeEvents(events), ...(error ? { error } : {}), requests: decodeRequests() };
}

async function compare(s: Script, request: Partial<DevinStreamRequest>, retry = false): Promise<Outcome> {
  script = s;
  const full: DevinStreamRequest = {
    model: { ...model, baseUrl },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    apiKey: "tok-123",
    sessionId: "cascade-1",
    ...request,
    ...(request.model ? { model: { ...request.model, baseUrl } } : {}),
  };
  const ts = await outcome(runTs, full, retry);
  const go = await outcome(runGo, full, retry);
  expect(go).toEqual(ts);
  return ts;
}

const usage = (fields: object) => create(ModelUsageStatsSchema, fields as never);
const call = (fields: object) => create(ChatToolCallSchema, fields as never);

describe.skipIf(!hasGo)("Devin: Go sidecar vs in-process core", () => {
  it("streams thinking, text, usage and a stop", async () => {
    const out = await compare(
      {
        chat: [
          {
            body: body(
              msg({ messageId: "m-1", deltaThinking: "let me " }),
              gzMsg({ deltaThinking: "think", deltaSignature: "sig-1" }),
              msg({ deltaText: "Hello" }),
              msg({ deltaText: ", world", usage: usage({ inputTokens: 10n, outputTokens: 3n, cacheReadTokens: 4n }) }),
              msg({ usage: usage({ inputTokens: 10n, outputTokens: 3n, cacheReadTokens: 4n }) }),
              msg({
                stopReason: StopReason.STOP_PATTERN,
                creditCost: 2,
                usage: usage({ inputTokens: 10n, outputTokens: 5n }),
              }),
              trailer({}),
            ),
          },
        ],
      },
      {},
    );
    expect(out.events.at(-1)).toEqual({ type: "done", stopReason: "stop", responseId: "m-1" });
  });

  it("assembles cumulative and delta tool-call JSON, including invalid arguments", async () => {
    const out = await compare(
      {
        chat: [
          {
            body: body(
              msg({ deltaText: "Running tools" }),
              msg({ deltaToolCalls: [call({ id: "c1", name: "read", argumentsJson: '{"pa' })] }),
              msg({ deltaToolCalls: [call({ argumentsJson: 'th":"a.ts"}' })] }),
              msg({ deltaToolCalls: [call({ id: "c2", name: "bash", argumentsJson: '{"cmd":"ls"' })] }),
              msg({ deltaToolCalls: [call({ id: "c2", argumentsJson: '{"cmd":"ls", "n": 1.50}' })] }),
              msg({ deltaToolCalls: [call({ id: "c3", name: "broken", argumentsJson: '{"x": [1, 2' })] }),
              msg({ deltaToolCalls: [call({ id: "c4", name: "noargs" })] }),
              msg({ deltaToolCalls: [call({ id: "c5", name: "array", argumentsJson: "[1]" })] }),
            ),
          },
        ],
      },
      {},
    );
    expect(out.events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("routes a router model through AssignModel and reports the upstream model", async () => {
    await compare(
      {
        assign: [
          {
            body: toBinary(
              AssignModelResponseSchema,
              create(AssignModelResponseSchema, {
                assignment: create(ModelAssignmentSchema, {
                  assignmentJwt: "assign-jwt",
                  modelUid: "MODEL_GOOGLE_GEMINI_3",
                }),
              }),
            ),
          },
        ],
        chat: [
          {
            body: body(
              msg({ deltaText: "routed", actualModelUid: "gemini-3-pro" }),
              msg({ stopReason: StopReason.MAX_TOKENS }),
            ),
          },
        ],
      },
      {
        model: { ...model, id: "adaptive", isModelRouter: true },
        tools: [
          {
            name: "pick",
            description: "Pick",
            parameters: {
              type: "object",
              properties: {
                n: { type: ["number", "null"], default: 3, minimum: 1 },
                s: { type: ["string", "integer"] },
              },
              additionalProperties: false,
              required: ["n"],
            },
          },
        ],
      },
    );
  });

  it("builds the same request from a rich history", async () => {
    await compare(
      { chat: [{ body: body(msg({ deltaText: "ok" })) }] },
      {
        systemPrompt: ["You are helpful.", "  ", "api_key=sk-abcdef123456 and devin-session-token$xyz"],
        effort: "high",
        model: { ...model, effortMap: { high: "swe-1-6-high" }, supportsParallelToolCalls: true },
        maxTokens: 4096,
        temperature: 0,
        topP: 0.9,
        stopSequences: ["STOP"],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
            strict: true,
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look " },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              { type: "text", text: "here" },
            ],
          },
          {
            role: "assistant",
            responseId: "native-1",
            content: [
              { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
              { type: "text", text: "I'll read it" },
              {
                type: "toolCall",
                id: "c1",
                name: "read",
                arguments: { path: "a.ts", n: 1.5, deep: { "2": 1, "1": [true, null] } },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "text", text: "contents ✓ \u2028" }],
            isError: false,
          },
          { role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "dropped" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "foreign turn" },
              { type: "thinking", thinking: "x", thinkingSignature: "not-native" },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c9",
            toolName: "bash",
            content: [{ type: "text", text: "boom" }],
            isError: true,
          },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ],
      },
    );
  });

  it("maps a Connect trailer rejection, and retries capacity before any content", async () => {
    const capacity = trailer({
      error: {
        code: "unavailable",
        message: "We are currently experiencing capacity issues",
        details: [{ type: "t", debug: { a: 1 } }],
      },
    });
    const failed = await compare({ chat: [{ body: body(capacity) }] }, {});
    expect(failed.error).toMatchObject({ class: "DevinStreamError", code: "unavailable" });
    const retried = await compare(
      { chat: [{ body: body(capacity) }, { body: body(msg({ deltaText: "second try" })) }] },
      {},
      true,
    );
    expect(retried.error).toBeUndefined();
    const exhausted = await compare({ chat: [{ body: body(capacity) }] }, {}, true);
    expect(exhausted.requests.filter((r) => (r as { path: string }).path.endsWith("GetChatMessage"))).toHaveLength(3);
  });

  it("does not retry a capacity rejection after content streamed", async () => {
    const out = await compare(
      {
        chat: [
          {
            body: body(
              msg({ deltaText: "partial" }),
              trailer({ error: { code: "unavailable", message: "overloaded" } }),
            ),
          },
        ],
      },
      {},
      true,
    );
    expect(out.error).toMatchObject({ class: "DevinStreamError" });
  });

  it("maps HTTP errors, with the JSON detail and Retry-After", async () => {
    const out = await compare(
      {
        chat: [
          {
            status: 429,
            headers: { "retry-after": "3", "content-type": "application/json" },
            body: JSON.stringify({ error: { message: "slow   down" } }),
          },
        ],
      },
      {},
    );
    expect(out.error).toMatchObject({ class: "DevinApiError", status: 429 });
    await compare(
      { chat: [{ status: 502, headers: { "content-type": "text/html" }, body: "<html>bad gateway</html>" }] },
      {},
    );
  });

  it("retries GetUserJwt with the raw key after a 401, and follows a pinned edge URL", async () => {
    const edge = () =>
      toBinary(
        GetUserJwtResponseSchema,
        create(GetUserJwtResponseSchema, { userJwt: "jwt-2", customApiServerUrl: `${baseUrl}/edge/` }),
      );
    await compare(
      {
        jwt: [{ status: 401, body: "unauthenticated" }, { body: edge() }],
        chat: [{ body: body(msg({ deltaText: "edge" })) }],
      },
      {},
    );
    const failed = await compare(
      { jwt: [{ status: 401, body: "nope" }], chat: [] },
      { apiKey: "devin-session-token$abc" },
    );
    expect(failed.error).toMatchObject({ class: "DevinApiError", status: 401 });
    const empty = await compare({ jwt: [{ body: new Uint8Array() }], chat: [] }, {});
    expect(empty.error).toMatchObject({ class: "DevinProtocolError" });
  });

  it("treats a large-history invalid_argument as context overflow", async () => {
    const big = "x".repeat(600 * 1024);
    const out = await compare(
      {
        chat: [{ body: body(trailer({ error: { code: "invalid_argument", message: "an internal error occurred" } })) }],
      },
      { messages: [{ role: "user", content: [{ type: "text", text: big }] }] },
    );
    expect(out.error).toMatchObject({ class: "DevinStreamError", overflow: true });
  });

  it("streamDevin and the capacity wrapper follow NS_BRIDGE_ENGINE", async () => {
    script = { chat: [{ body: body(msg({ deltaText: "via engine" })) }] };
    const request: DevinStreamRequest = {
      model: { ...model, baseUrl },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      apiKey: "tok",
      sessionId: "s",
    };
    const saved = { engine: process.env.NS_BRIDGE_ENGINE, bin: process.env.NS_BRIDGE_BIN };
    process.env.NS_BRIDGE_ENGINE = "go";
    process.env.NS_BRIDGE_BIN = join(tmpdir(), "definitely-not-ns-bridge");
    try {
      // A missing binary under an explicit `go` is an error, proving the call went to the sidecar.
      await expect(outcome((r) => streamDevin(r), request, false)).resolves.toMatchObject({
        error: { class: "other", message: expect.stringContaining("Cannot start the ns-bridge binary") },
      });
      process.env.NS_BRIDGE_BIN = sidecar?.bin;
      const viaGo = await outcome((r) => streamDevin(r), request, false);
      const viaRetry = await outcome((r) => streamDevinWithCapacityRetry(r), request, false);
      process.env.NS_BRIDGE_ENGINE = "ts";
      const viaTs = await outcome((r) => streamDevin(r), request, false);
      expect(viaGo).toEqual(viaTs);
      expect(viaRetry).toEqual(viaTs);
    } finally {
      for (const [key, value] of [
        ["NS_BRIDGE_ENGINE", saved.engine],
        ["NS_BRIDGE_BIN", saved.bin],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

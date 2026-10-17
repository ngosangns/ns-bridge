// Differential tests: the same Kiro turns, against the same scripted runtime
// and management server, through the in-process TypeScript core and the Go
// sidecar (via the engine facade). Events, errors and the requests each engine
// sends must agree. Skipped without Go.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SidecarError } from "ns-bridge-core/sidecar";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetCacheEstimatorForTests } from "../src/cache-estimator.js";
import { KiroApiError } from "../src/errors.js";
import { KiroManagementHttpError } from "../src/management.js";
import type { KiroModel } from "../src/models.js";
import { capacityRetryConfig } from "../src/retry.js";
import { type KiroStreamRequest, resetProfileArnCache, streamKiro, streamKiroInProcess } from "../src/stream.js";
import type { KiroStreamEvent } from "../src/types.js";
import {
  concatMessages,
  encodeEventMessage,
  encodeExceptionMessage,
  encodeRawExceptionMessage,
} from "./helpers/event-stream.js";
import { buildSidecar, hasGo } from "./helpers/go-sidecar.js";
import { RECORD_279_TEXT } from "./helpers/invoke-fixture.js";

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: Uint8Array | string;
}

interface Script {
  runtime: Reply[];
  management?: Reply[];
}

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let server: Server;
let baseUrl = "";
let script: Script = { runtime: [] };
let recorded: Recorded[] = [];
let sidecar: { bin: string; cleanup: () => void } | undefined;
const savedEnv = { ...process.env };

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function next(list: Reply[] | undefined, prefix: string, fallback: Reply): Reply {
  const count = recorded.filter((r) => r.url.startsWith(prefix)).length - 1;
  if (!list || list.length === 0) return fallback;
  return list[Math.min(count, list.length - 1)];
}

const IGNORED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept",
  "accept-encoding",
  "accept-language",
  "sec-fetch-mode",
  "user-agent",
]);

beforeAll(async () => {
  if (!hasGo) return;
  sidecar = buildSidecar();
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (!IGNORED_HEADERS.has(k)) headers[k] = Array.isArray(v) ? v.join(",") : String(v);
    recorded.push({ method: req.method ?? "", url, headers, body: body.toString("utf8") });
    const reply = url.startsWith("/runtime/")
      ? next(script.runtime, "/runtime/", { status: 500, body: "no runtime scripted" })
      : next(script.management, "/management/", { status: 500, body: "no management scripted" });
    res.writeHead(reply.status ?? 200, reply.headers ?? {});
    res.end(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KIRO_RUNTIME_ENDPOINT = `${baseUrl}/runtime/{region}/`;
  process.env.KIRO_MANAGEMENT_ENDPOINT = `${baseUrl}/management/{region}/`;
}, 180_000);

afterAll(async () => {
  for (const key of ["KIRO_RUNTIME_ENDPOINT", "KIRO_MANAGEMENT_ENDPOINT", "NS_BRIDGE_ENGINE_KIRO", "NS_BRIDGE_BIN"])
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  sidecar?.cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const savedCapacity = { ...capacityRetryConfig };
beforeEach(() => {
  capacityRetryConfig.maxRetries = 2;
  capacityRetryConfig.baseDelayMs = 10;
  return () => Object.assign(capacityRetryConfig, savedCapacity);
});

const ok = (...events: object[]): Reply => ({ body: concatMessages(...events.map((e) => encodeEventMessage(e))) });
const frames = (...messages: Uint8Array[]): Reply => ({ body: concatMessages(...messages) });
const fail = (status: number, body: string, headers?: Record<string, string>): Reply => ({
  status,
  body,
  ...(headers ? { headers } : {}),
});

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model: KiroModel = {
  id: "claude-sonnet-4-5",
  kiroModelId: "claude-sonnet-4.5",
  name: "Sonnet",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 65536,
  region: "us-east-1",
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX32 = /\b[0-9a-f]{32}\b/g;
const normalize = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .replace(UUID, "<uuid>")
      .replace(HEX32, "<hex>"),
  );

function describeError(error: unknown) {
  if (error instanceof KiroApiError)
    return {
      class: "KiroApiError",
      message: error.message,
      status: error.status,
      reasonCode: error.reasonCode,
      retryAfterMs: error.retryAfterMs,
      providerAttempts: error.providerAttempts,
    };
  if (error instanceof KiroManagementHttpError)
    return { class: "KiroManagementHttpError", message: error.message, status: error.status };
  if (error instanceof SidecarError) return { class: "SidecarError", kind: error.kind, message: error.message };
  return { class: error?.constructor?.name ?? "unknown", message: error instanceof Error ? error.message : error };
}

type Run = (request: KiroStreamRequest) => AsyncIterable<KiroStreamEvent>;

function useEngine(engine: "go" | "ts"): void {
  if (engine === "go") {
    process.env.NS_BRIDGE_ENGINE_KIRO = "go";
    process.env.NS_BRIDGE_BIN = sidecar?.bin;
  } else {
    process.env.NS_BRIDGE_ENGINE_KIRO = "ts";
  }
}

interface Outcome {
  turns: { events: unknown[]; error?: unknown }[];
  requests: unknown[];
}

async function outcome(engine: "go" | "ts", requests: KiroStreamRequest[], resolveProfiles: boolean): Promise<Outcome> {
  recorded = [];
  resetProfileArnCache(!resolveProfiles);
  resetCacheEstimatorForTests();
  useEngine(engine);
  const run: Run = engine === "go" ? streamKiro : streamKiroInProcess;
  const turns: Outcome["turns"] = [];
  try {
    for (const request of requests) {
      const events: KiroStreamEvent[] = [];
      let error: unknown;
      try {
        for await (const event of run(request)) events.push(event);
      } catch (caught) {
        error = describeError(caught);
      }
      turns.push({ events: normalize(events) as unknown[], ...(error ? { error: normalize(error) } : {}) });
    }
  } finally {
    useEngine("ts");
  }
  const sent = recorded.map((r) => {
    let body: unknown = r.body;
    try {
      body = JSON.parse(r.body);
    } catch {}
    return normalize({ method: r.method, url: r.url, headers: r.headers, body });
  });
  return { turns, requests: sent };
}

function request(overrides: Partial<KiroStreamRequest> = {}): KiroStreamRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    systemPrompt: "You are helpful",
    accessToken: "test-token",
    sessionId: "conv-1",
    ...overrides,
  };
}

async function compare(
  s: Script,
  requests: KiroStreamRequest[] | KiroStreamRequest = request(),
  options: { resolveProfiles?: boolean } = {},
): Promise<Outcome> {
  script = s;
  const list = Array.isArray(requests) ? requests : [requests];
  const ts = await outcome("ts", list, options.resolveProfiles ?? false);
  const go = await outcome("go", list, options.resolveProfiles ?? false);
  expect(go).toEqual(ts);
  return ts;
}

const lastEvent = (out: Outcome, turn = 0) => out.turns[turn].events.at(-1);

describe.skipIf(!hasGo)("Kiro: Go sidecar vs in-process core", { timeout: 60_000 }, () => {
  it("streams text and usage", async () => {
    const out = await compare({
      runtime: [
        ok(
          { content: "Hello" },
          { content: " world" },
          { tokenUsage: { uncachedInputTokens: 120, outputTokens: 30, cacheReadInputTokens: 0 } },
          { unit: "credit", unitPlural: "credits", usage: 0.42 },
          { contextUsagePercentage: 12 },
        ),
      ],
    });
    expect(out.turns[0].error).toBeUndefined();
    expect(lastEvent(out)).toMatchObject({ type: "done" });
  });

  it("carries thinking, tool calls and a tool-result history", async () => {
    const out = await compare(
      {
        runtime: [
          ok(
            { text: "weighing it" },
            { signature: "sig-abc" },
            { content: "Let me look." },
            { name: "read_file", toolUseId: "t9", input: '{"path":', stop: false },
            { name: "read_file", toolUseId: "t9", input: '"/b"}', stop: true },
            { contextUsagePercentage: 20 },
          ),
        ],
      },
      request({
        model: { ...model, reasoning: true },
        effort: "high",
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "Open /a" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Opening." },
              { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/a" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            content: [{ type: "text", text: "contents of a" }],
            isError: false,
          },
          { role: "user", content: [{ type: "text", text: "Now /b" }] },
        ] as KiroStreamRequest["messages"],
      }),
    );
    expect(out.turns[0].error).toBeUndefined();
  });

  it("drops tool calls with unparseable arguments", async () => {
    await compare({
      runtime: [
        ok(
          { content: "here you go" },
          { name: "read", toolUseId: "t3", input: "{not json", stop: true },
          { contextUsagePercentage: 10 },
        ),
      ],
    });
  });

  it("recovers tool calls leaked as text", async () => {
    await compare(
      { runtime: [ok({ content: RECORD_279_TEXT }, { contextUsagePercentage: 10 })] },
      request({
        tools: [
          {
            name: "shell",
            description: "Run a command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
      }),
    );
  });

  it("estimates cache reads across turns of one conversation", async () => {
    const tracking = {
      estimateDollarValue: true,
      usdPerCredit: 0.04,
      estimateCacheUsage: true,
      estimatedCacheTimeout: 300_000,
    };
    const out = await compare(
      {
        runtime: [
          ok({ content: "one" }, { tokenUsage: { uncachedInputTokens: 500, outputTokens: 100 } }, { usage: 1.5 }),
          ok({ content: "two" }, { tokenUsage: { uncachedInputTokens: 700, outputTokens: 50 } }, { usage: 0.5 }),
        ],
      },
      [request({ usageTracking: tracking }), request({ usageTracking: tracking })],
    );
    expect(JSON.stringify(out.turns[1].events)).toContain('"cacheEstimated":true');
  });

  it("maps HTTP errors to KiroApiError", async () => {
    const out = await compare({
      runtime: [fail(400, '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}')],
    });
    expect(out.turns[0].error).toMatchObject({ class: "KiroApiError", status: 400 });
  });

  it("reports a too-large request", async () => {
    await compare({ runtime: [fail(413, "Request entity too large")] });
  });

  it("does not retry a monthly quota 429", async () => {
    await compare({
      runtime: [fail(429, '{"message":"limit","reason":"MONTHLY_REQUEST_COUNT"}', { "retry-after": "30" })],
    });
  });

  it("retries a request-rate window, then succeeds", async () => {
    await compare({
      runtime: [
        fail(429, '{"message":"slow down","reason":"USER_REQUEST_RATE_EXCEEDED"}', { "retry-after": "0" }),
        ok({ content: "after the window" }, { contextUsagePercentage: 5 }),
      ],
    });
  });

  it("retries capacity errors with backoff, then gives up", async () => {
    const out = await compare({
      runtime: [fail(429, '{"message":"busy","reason":"INSUFFICIENT_MODEL_CAPACITY"}')],
    });
    expect(out.requests).toHaveLength(3);
  });

  it("retries capacity errors, then succeeds", async () => {
    await compare({
      runtime: [
        fail(429, '{"message":"busy","reason":"INSUFFICIENT_MODEL_CAPACITY"}'),
        ok({ content: "finally" }, { contextUsagePercentage: 5 }),
      ],
    });
  });

  it("retries a 403 once credentials cannot be refreshed", async () => {
    await compare({
      runtime: [fail(403, '{"message":"expired"}'), ok({ content: "ok now" }, { contextUsagePercentage: 5 })],
    });
  });

  it("retries an empty response", async () => {
    await compare({
      runtime: [ok({ contextUsagePercentage: 10 }), ok({ content: "Second time" }, { contextUsagePercentage: 10 })],
    });
  });

  it("retries an echo loop when the host can discard blocks", async () => {
    await compare(
      {
        runtime: [
          ok({ content: "Continue" }, { contextUsagePercentage: 10 }),
          ok({ content: "Real answer" }, { contextUsagePercentage: 10 }),
        ],
      },
      request({ canDiscardEmittedBlocks: true }),
    );
  });

  it.each([["MODEL_CONTEXT_WINDOW_EXCEEDED"], ["CONTENT_FILTERED"], ["PAUSE_TURN"]])(
    "ends on the terminal stop reason %s",
    async (stopReason) => {
      await compare({ runtime: [ok({ content: "partial" }, { stopReason }, { contextUsagePercentage: 100 })] });
    },
  );

  it("surfaces exception frames", async () => {
    await compare({
      runtime: [
        frames(
          encodeEventMessage({ content: "partial" }),
          encodeExceptionMessage("throttlingError", { message: "Too many requests" }),
        ),
      ],
    });
  });

  it("surfaces unknown exception frames", async () => {
    await compare({
      runtime: [frames(encodeRawExceptionMessage("ThrottlingException", { message: "boom" }))],
    });
  });

  it("resolves the profile through management and caches it across turns", async () => {
    const out = await compare(
      {
        management: [
          { body: JSON.stringify({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/P1" }] }) },
        ],
        runtime: [ok({ content: "one" }, { contextUsagePercentage: 5 }), ok({ content: "two" })],
      },
      [request(), request()],
      { resolveProfiles: true },
    );
    expect(out.requests.filter((r) => JSON.stringify(r).includes("/management/"))).toHaveLength(1);
  });

  it("fails when management rejects the token", async () => {
    await compare({ management: [fail(403, "denied")], runtime: [] }, request(), { resolveProfiles: true });
  });
});

export { ZERO_COST };

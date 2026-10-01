// ABOUTME: The harness usage chunk must carry a cache read or the session pill stays at 0%.

import type { GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { KiroStreamRequest, KiroUsage } from "ns-kiro-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamKiro = vi.hoisted(() => vi.fn());

vi.mock("ns-kiro-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ns-kiro-core")>();
  return { ...actual, streamKiro };
});

import { KiroAdapter } from "../src/adapter.js";

const SESSION = "session-1" as NonNullable<GenerateOptions["sessionId"]>;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(partial: Partial<KiroUsage> & Pick<KiroUsage, "input" | "output" | "totalTokens">): KiroUsage {
  return { cost: ZERO_COST, ...partial };
}

function adapter(): KiroAdapter {
  return new KiroAdapter({
    provider: "kiro",
    displayName: "Kiro",
    credentials: async () => ({
      access: "test-token",
      refresh: "refresh|idc",
      expires: Date.now() + 60_000,
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
      authMethod: "idc",
      profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/test",
    }),
  });
}

const user = { role: "user", content: [{ type: "text", text: "hello" }] } as Message;

type CoreEvent = { type: "usage"; usage: KiroUsage } | { type: "done"; stopReason: "stop" };

async function collect(events: CoreEvent[]): Promise<{
  chunks: StreamChunk[];
  request: KiroStreamRequest;
}> {
  streamKiro.mockImplementation(async function* (request: KiroStreamRequest) {
    recorded = request;
    for (const event of events) yield event;
  });
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter().stream({
    provider: "kiro",
    model: "claude-haiku-4-5",
    messages: [user],
    sessionId: SESSION,
  })) {
    chunks.push(chunk);
  }
  return { chunks, request: recorded as KiroStreamRequest };
}

let recorded: KiroStreamRequest | undefined;

describe("KiroAdapter cache usage", () => {
  beforeEach(() => {
    recorded = undefined;
    streamKiro.mockReset();
  });

  it("opts the session into cache estimation and forwards a repeated-prefix read", async () => {
    const { chunks, request } = await collect([
      { type: "usage", usage: usage({ input: 400, output: 40, totalTokens: 1540, cacheRead: 1100 }) },
      { type: "done", stopReason: "stop" },
    ]);

    expect(request.sessionId).toBe(SESSION);
    expect(request.usageTracking).toMatchObject({ estimateCacheUsage: true, estimateDollarValue: false });
    expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
      type: "usage",
      usage: {
        inputTokens: 400,
        outputTokens: 40,
        totalTokens: 1540,
        cacheReadTokens: 1100,
        cacheWriteTokens: 0,
      },
    });
  });

  it("reports a cold prefix as a zero cache read so a later step in the turn can still sum", async () => {
    const { chunks } = await collect([
      { type: "usage", usage: usage({ input: 1000, output: 100, totalTokens: 1100 }) },
      { type: "done", stopReason: "stop" },
    ]);

    expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
      type: "usage",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  });

  it("omits cache fields when they would not add up to the reported total", async () => {
    const { chunks } = await collect([
      { type: "usage", usage: usage({ input: 1000, output: 100, totalTokens: 9999, cacheRead: 50 }) },
      { type: "done", stopReason: "stop" },
    ]);

    expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 9999 },
    });
  });
});

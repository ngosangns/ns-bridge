// ABOUTME: Tests the Arnict HTTP layer against fake fetch responses, never the network.
// ABOUTME: Covers request mapping, SSE framing, usage pricing, retries, and the models list.

import { describe, expect, it } from "vitest";
import { ArnictApiError } from "../src/errors.js";
import { fetchArnictModelIds } from "../src/models-api.js";
import { buildChatCompletionsBody } from "../src/request.js";
import { parseSseData } from "../src/sse.js";
import { streamArnict } from "../src/stream.js";
import type { ArnictMessage, ArnictStreamEvent } from "../src/types.js";

const MODEL = "zai/glm-5.3-flash-uncensored";
const KEY = "sk-arnict-secret-value-0001";
const encoder = new TextEncoder();

async function collect(events: AsyncIterable<ArnictStreamEvent>): Promise<ArnictStreamEvent[]> {
  const out: ArnictStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sseResponse(frames: string[]): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index];
      index += 1;
      if (frame === undefined) controller.close();
      else controller.enqueue(encoder.encode(frame));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers).entries()) headers[name] = value;
    calls.push({ url: String(input), headers });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: impl as typeof fetch, calls };
}

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type UsageEvent = Extract<ArnictStreamEvent, { type: "usage" }>;

function usageEvent(events: ArnictStreamEvent[]): UsageEvent | undefined {
  return events.find((event): event is UsageEvent => event.type === "usage");
}

const userTurn: ArnictMessage[] = [{ role: "user", content: [{ type: "text", text: "Hi" }] }];

describe("buildChatCompletionsBody", () => {
  it("maps system prompt, user text, and request options", () => {
    const body = buildChatCompletionsBody({
      model: MODEL,
      systemPrompt: "Be brief.",
      maxTokens: 512,
      messages: userTurn,
    });
    expect(body).toEqual({
      model: MODEL,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
    });
  });

  it("sends images as base64 data URLs and keeps text parts", () => {
    const body = buildChatCompletionsBody({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("maps assistant tool calls, drops thinking, and answers with a tool message", () => {
    const body = buildChatCompletionsBody({
      model: MODEL,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "Let me check." },
            { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/x" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: [
            { type: "text", text: "contents" },
            { type: "image", mimeType: "image/jpeg", data: "BB" },
          ],
          isError: false,
        },
      ],
    });
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents\n[image omitted]" },
    ]);
  });

  it("sends tools as function definitions and omits max_tokens when unset", () => {
    const body = buildChatCompletionsBody({
      model: MODEL,
      messages: userTurn,
      tools: [{ name: "ls", description: "List files", parameters: { type: "object" } }],
    });
    expect(body.tools).toEqual([
      { type: "function", function: { name: "ls", description: "List files", parameters: { type: "object" } } },
    ]);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("parseSseData", () => {
  it("reassembles split chunks, skips comments, and stops at [DONE]", async () => {
    const parsed: unknown[] = [];
    const chunks = [
      ": keep-alive\n\n",
      'data: {"id":"c1","choi',
      'ces":[{"delta":{"content":"He"}}]}\n\ndata: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: {"id":"c1","choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\ndata: {"after":true}\n\n',
    ];
    for await (const event of parseSseData(
      (async function* () {
        for (const chunk of chunks) yield encoder.encode(chunk);
      })(),
    )) {
      parsed.push(event);
    }
    expect(parsed).toEqual([
      { id: "c1", choices: [{ delta: { content: "He" } }] },
      { id: "c1", choices: [{ delta: { content: "llo" } }] },
      { id: "c1", choices: [{ delta: { content: "!" } }] },
    ]);
  });

  it("tolerates CRLF frame separators", async () => {
    const parsed: unknown[] = [];
    for await (const event of parseSseData(
      (async function* () {
        yield encoder.encode('data: {"id":"c2"}\r\n\r\ndata: [DONE]\r\n\r\n');
      })(),
    )) {
      parsed.push(event);
    }
    expect(parsed).toEqual([{ id: "c2" }]);
  });
});

describe("streamArnict", () => {
  it("streams text and prices usage with the flash rates", async () => {
    const { fetch: impl, calls } = fakeFetch([
      sseResponse([
        dataFrame({ id: "resp_1", model: MODEL, choices: [{ delta: { content: "Hello" } }] }),
        dataFrame({ id: "resp_1", model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }] }),
        dataFrame({
          id: "resp_1",
          model: MODEL,
          choices: [],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_tokens_details: { cached_tokens: 200 },
          },
        }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const events = await collect(streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }));
    const usage = usageEvent(events);
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, delta: "Hello" },
      { type: "text_end", index: 0, text: "Hello" },
      { type: "done", stopReason: "stop", responseId: "resp_1", upstreamModel: MODEL },
    ]);
    expect(usage?.usage).toMatchObject({
      input: 800,
      output: 100,
      totalTokens: 1100,
      cacheRead: 200,
      creditUnit: "USD",
    });
    expect(usage?.usage?.cost.input).toBeCloseTo(0.0001, 15);
    expect(usage?.usage?.cost.cacheRead).toBeCloseTo(0.00001, 15);
    expect(usage?.usage?.cost.output).toBeCloseTo(0.00005, 15);
    expect(usage?.usage?.cost.total).toBeCloseTo(0.00016, 15);
    expect(usage?.usage?.credits).toBeCloseTo(0.00016, 15);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.arnict.com/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers.accept).toBe("text/event-stream");
  });

  it("maps reasoning_content and reasoning deltas onto thinking events", async () => {
    const { fetch: impl } = fakeFetch([
      sseResponse([
        dataFrame({ id: "resp_2", model: MODEL, choices: [{ delta: { reasoning_content: "Step one." } }] }),
        dataFrame({ id: "resp_2", model: MODEL, choices: [{ delta: { reasoning: " Step two." } }] }),
        dataFrame({ id: "resp_2", model: MODEL, choices: [{ delta: { content: "Answer" } }] }),
        dataFrame({ id: "resp_2", model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const events = await collect(streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }));
    expect(events).toEqual([
      { type: "start" },
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, delta: "Step one." },
      { type: "thinking_delta", index: 0, delta: " Step two." },
      { type: "thinking_end", index: 0, thinking: "Step one. Step two." },
      { type: "text_start", index: 1 },
      { type: "text_delta", index: 1, delta: "Answer" },
      { type: "text_end", index: 1, text: "Answer" },
      { type: "done", stopReason: "stop", responseId: "resp_2", upstreamModel: MODEL },
    ]);
  });

  it("assembles tool calls across chunks and finishes with toolUse", async () => {
    const { fetch: impl } = fakeFetch([
      sseResponse([
        dataFrame({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } },
          ],
        }),
        dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp"}' } }] } }] }),
        dataFrame({
          choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "ls", arguments: "{}" } }] } }],
        }),
        dataFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const events = await collect(streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }));
    expect(events).toEqual([
      { type: "start" },
      { type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
      { type: "tool_call_delta", index: 0, id: "call_1", argumentsDelta: '{"pa' },
      { type: "tool_call_delta", index: 0, id: "call_1", argumentsDelta: 'th":"/tmp"}' },
      { type: "tool_call_start", index: 1, id: "call_2", name: "ls" },
      { type: "tool_call_delta", index: 1, id: "call_2", argumentsDelta: "{}" },
      {
        type: "tool_call_end",
        index: 0,
        id: "call_1",
        name: "read_file",
        arguments: { path: "/tmp" },
        argumentsJson: '{"path":"/tmp"}',
      },
      { type: "tool_call_end", index: 1, id: "call_2", name: "ls", arguments: {}, argumentsJson: "{}" },
      { type: "done", stopReason: "toolUse" },
    ]);
  });

  it("retries a 429 after the advertised Retry-After and then succeeds", async () => {
    const { fetch: impl, calls } = fakeFetch([
      errorResponse(429, { error: { message: "rate limited", code: "rate_limit_exceeded" } }, { "retry-after": "0.5" }),
      sseResponse([
        dataFrame({ id: "resp_3", model: MODEL, choices: [{ delta: { content: "ok" } }] }),
        dataFrame({ id: "resp_3", model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const sleeps: number[] = [];
    const events = await collect(
      streamArnict({
        model: MODEL,
        messages: userTurn,
        apiKey: KEY,
        fetchImpl: impl,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("does not retry a 401 and never echoes the key", async () => {
    const { fetch: impl, calls } = fakeFetch([
      errorResponse(401, { error: { message: "invalid key", code: "invalid_api_key" } }),
    ]);
    const failure = await collect(
      streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ArnictApiError);
    const apiError = failure as ArnictApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("invalid_api_key");
    expect(apiError.message).toBe("Arnict error (401 invalid_api_key): invalid key");
    expect(apiError.message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 429 that reports insufficient_quota", async () => {
    const { fetch: impl, calls } = fakeFetch([
      errorResponse(429, { error: { message: "quota exceeded", code: "insufficient_quota" } }),
    ]);
    const failure = await collect(
      streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ArnictApiError);
    expect((failure as ArnictApiError).code).toBe("insufficient_quota");
    expect(calls).toHaveLength(1);
  });

  it("converts a non-stream JSON completion into the same events", async () => {
    const { fetch: impl } = fakeFetch([
      jsonResponse({
        id: "resp_9",
        model: MODEL,
        choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ]);
    const events = await collect(streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }));
    const usage = usageEvent(events);
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, delta: "Hi there" },
      { type: "text_end", index: 0, text: "Hi there" },
      { type: "done", stopReason: "stop", responseId: "resp_9", upstreamModel: MODEL },
    ]);
    expect(usage?.usage).toMatchObject({
      input: 10,
      output: 2,
      totalTokens: 12,
      cacheRead: 0,
      creditUnit: "USD",
    });
    expect(usage?.usage?.cost.input).toBeCloseTo(0.00000125, 15);
    expect(usage?.usage?.cost.output).toBeCloseTo(0.000001, 15);
    expect(usage?.usage?.cost.total).toBeCloseTo(0.00000225, 15);
    expect(usage?.usage?.credits).toBeCloseTo(0.00000225, 15);
  });

  it("finishes a stream that ends without finish_reason with an error message", async () => {
    const { fetch: impl } = fakeFetch([
      sseResponse([dataFrame({ id: "resp_404", model: MODEL, choices: [{ delta: { content: "partial" } }] })]),
    ]);
    const events = await collect(streamArnict({ model: MODEL, messages: userTurn, apiKey: KEY, fetchImpl: impl }));
    expect(events[events.length - 1]).toEqual({
      type: "done",
      stopReason: "stop",
      errorMessage: "Arnict stream ended early",
      responseId: "resp_404",
      upstreamModel: MODEL,
    });
  });
});

describe("fetchArnictModelIds", () => {
  it("returns the model ids from GET /models with the bearer key", async () => {
    const { fetch: impl, calls } = fakeFetch([
      jsonResponse({
        object: "list",
        data: [{ id: MODEL }, { id: "zai/glm-5.3-uncensored" }, { id: 5 }],
      }),
    ]);
    const ids = await fetchArnictModelIds({ apiKey: KEY, fetchImpl: impl });
    expect(ids).toEqual([MODEL, "zai/glm-5.3-uncensored"]);
    expect(calls[0]?.url).toBe("https://api.arnict.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("honors a baseUrl override and raises ArnictApiError on HTTP failures", async () => {
    const { fetch: impl, calls } = fakeFetch([
      errorResponse(401, { error: { message: "bad key", code: "invalid_api_key" } }),
    ]);
    const failure = await fetchArnictModelIds({
      apiKey: KEY,
      baseUrl: "https://proxy.example/v1/",
      fetchImpl: impl,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(calls[0]?.url).toBe("https://proxy.example/v1/models");
    expect(failure).toBeInstanceOf(ArnictApiError);
    expect((failure as ArnictApiError).status).toBe(401);
  });
});

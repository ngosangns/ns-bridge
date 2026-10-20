import { describe, expect, it } from "vitest";
import { GROK_LOGIN_MESSAGE, GrokApiError } from "../src/errors.js";
import { streamGrok } from "../src/stream.js";

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

describe("streamGrok", () => {
  it("posts the host tool to the CLI proxy and maps the SSE body", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(
        sse([
          { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
          { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Think" },
          { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "ping", arguments: "" },
          },
          { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"value":"HOST-PING"}' },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              usage: {
                input_tokens: 208,
                input_tokens_details: { cached_tokens: 128 },
                output_tokens: 39,
                total_tokens: 247,
              },
            },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const events = [];
    for await (const event of streamGrok({
      model: "grok-4.7-agent",
      systemPrompt: "be brief",
      accessToken: "session-token",
      clientVersion: "1.2.3",
      proxyBaseUrl: "https://cli-chat-proxy.grok.com/v1",
      fetchImpl: fetchImpl as typeof fetch,
      tools: [
        {
          name: "ping",
          description: "echo",
          parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "ping" }] },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "SECRET-THOUGHT" }],
        },
      ],
    })) {
      events.push(event);
    }

    expect(captured?.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer session-token");
    expect(captured?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(captured?.headers.get("x-grok-client-version")).toBe("1.2.3");
    expect(captured?.headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(captured?.headers.get("x-grok-client-mode")).toBe("xai-grok-cli");
    expect(captured?.headers.get("user-agent")).toBe("grok-cli/1.2.3");
    expect(captured?.headers.get("x-grok-model-override")).toBe("grok-4.7");
    expect(captured?.body.model).toBe("grok-4.7");
    expect(JSON.stringify(captured?.body.tools)).toContain("ping");
    expect(JSON.stringify(captured?.body)).not.toContain("read_file");
    expect(JSON.stringify(captured?.body)).not.toContain("SECRET-THOUGHT");
    expect(events).toContainEqual({ type: "thinking_end", index: 0, thinking: "Think" });
    expect(events).toContainEqual({
      type: "tool_call_end",
      index: 1,
      id: "call_1",
      name: "ping",
      arguments: { value: "HOST-PING" },
      argumentsJson: '{"value":"HOST-PING"}',
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        input: 80,
        output: 39,
        cacheRead: 128,
        totalTokens: 247,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("surfaces the proxy status without calling a console API key", async () => {
    const fetchImpl = async () => new Response("Your Grok CLI version (none) is outdated", { status: 426 });
    await expect(
      streamGrok({
        model: "grok-4.7",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        accessToken: "session-token",
        clientVersion: "1.2.3",
        fetchImpl: fetchImpl as typeof fetch,
      }).next(),
    ).rejects.toMatchObject({ name: "GrokApiError", status: 426 });
  });

  it("reports a missing CLI login", async () => {
    const missing = streamGrok({
      model: "grok-4.7",
      messages: [],
      loadAccess: async () => {
        throw new Error(GROK_LOGIN_MESSAGE);
      },
    });
    await expect(missing.next()).rejects.toThrow(GROK_LOGIN_MESSAGE);
    expect(GrokApiError).toBeTypeOf("function");
  });
});

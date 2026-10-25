import { describe, expect, it } from "vitest";
import { buildResponsesBody, estimateResponsesTokens } from "../src/request.js";

const ping = {
  name: "ping",
  description: "echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

describe("Responses request body", () => {
  it("sends the host tool and leaves Grok's own tools out", () => {
    const body = buildResponsesBody({
      model: "grok-4.7",
      systemPrompt: "be brief",
      effort: "low",
      tools: [ping],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET-THOUGHT" },
            { type: "text", text: "ok" },
            { type: "toolCall", id: "call_1", name: "ping", arguments: { value: "a" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "ping",
          isError: false,
          content: [{ type: "text", text: "a" }],
        },
        {
          role: "user",
          content: [{ type: "image", data: "aaaa", mimeType: "image/png" }],
        },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    });

    const encoded = JSON.stringify(body);
    expect(body.model).toBe("grok-4.7");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("be brief");
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.tools).toEqual([{ type: "function", ...ping }]);
    expect(encoded).not.toContain("read_file");
    expect(encoded).not.toContain("SECRET-THOUGHT");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", call_id: "call_1", name: "ping", arguments: '{"value":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "a" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,aaaa" }],
      },
    ]);
  });

  it("clamps effort max to xhigh because grok rejects max with 400 Invalid reasoning effort", () => {
    const body = buildResponsesBody({
      model: "grok-4.7",
      effort: "max",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("drops the oldest turns once the body is past the context window", () => {
    const filler = "x".repeat(400);
    const body = buildResponsesBody({
      model: "grok-4.7",
      contextWindow: 200,
      messages: [
        { role: "user", content: [{ type: "text", text: `old ${filler}` }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_old", name: "ping", arguments: { value: filler } }],
        },
        {
          role: "toolResult",
          toolCallId: "call_old",
          toolName: "ping",
          isError: false,
          content: [{ type: "text", text: filler }],
        },
        { role: "user", content: [{ type: "text", text: "latest question" }] },
      ],
    });

    const input = body.input as Array<{ type: string; call_id?: string }>;
    expect(input.map((item) => item.type)).toEqual(["message"]);
    expect(JSON.stringify(input)).toContain("latest question");
    expect(JSON.stringify(input)).not.toContain("call_old");
    expect(estimateResponsesTokens(body)).toBeLessThanOrEqual(200);
  });

  it("keeps a single item that is larger than the window on its own", () => {
    const body = buildResponsesBody({
      model: "grok-4.7",
      contextWindow: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(400) }] }],
    });
    expect(body.input).toHaveLength(1);
  });

  it("omits reasoning when the host turned it off", () => {
    const body = buildResponsesBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBeUndefined();
  });

  it("sends the conversation's prompt cache key so xAI routes every turn to one cache", () => {
    const body = buildResponsesBody({
      model: "grok-4.7",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      promptCacheKey: " session-abc ",
    });
    expect(body.prompt_cache_key).toBe("session-abc");
  });

  it("omits the prompt cache key when the host has no conversation id", () => {
    for (const promptCacheKey of [undefined, "", "   "]) {
      const body = buildResponsesBody({
        model: "grok-4.7",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        promptCacheKey,
      });
      expect(body).not.toHaveProperty("prompt_cache_key");
    }
  });
});

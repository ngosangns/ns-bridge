// ABOUTME: Tests the projection from the Anthropic Messages request onto the neutral one,
// ABOUTME: including the real captured ZCode request in fixtures/zcode-request.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toBridgeRequest } from "../src/anthropic/request.js";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/zcode-request.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

/** Loosely typed on purpose: the wire bodies below are hand-built request JSON. */
const request = (body: Record<string, unknown>) => body;

function project(body: unknown) {
  const out = toBridgeRequest(body);
  if (!("context" in out)) throw new Error(`unexpected error: ${out.error}`);
  return out;
}

describe("toBridgeRequest", () => {
  it("projects the captured ZCode request", () => {
    const out = project(FIXTURE);
    expect(out.model).toBe("claude-sonnet-4.5");
    expect(out.maxTokens).toBe(32000);
    expect(out.stream).toBe(true);
    expect(out.effort).toBe("high");
    const system = FIXTURE.system as Array<{ text: string }>;
    expect(out.context.systemPrompt).toBe(system.map((block) => block.text).join("\n\n"));
    const tools = FIXTURE.tools as Array<{ name: string; description: string; input_schema: unknown }>;
    expect(out.context.tools?.map((tool) => tool.name)).toEqual(["Bash", "Edit", "Read"]);
    expect(out.context.tools?.[0]).toEqual({
      name: tools[0]?.name,
      description: tools[0]?.description,
      parameters: tools[0]?.input_schema,
    });
    const userBlocks = (FIXTURE.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content ?? [];
    expect(out.context.messages).toEqual([
      { role: "user", content: userBlocks.map((block) => ({ type: "text", text: block.text })) },
    ]);
  });

  it("rejects a non-object body, a missing model, and missing or empty messages", () => {
    expect(toBridgeRequest(null)).toEqual({ error: "request body must be a JSON object" });
    expect(toBridgeRequest("hi")).toEqual({ error: "request body must be a JSON object" });
    expect(toBridgeRequest([])).toEqual({ error: "request body must be a JSON object" });
    expect(toBridgeRequest({ messages: [{ role: "user", content: "hi" }] })).toEqual({ error: "model is required" });
    expect(toBridgeRequest({ model: "m" })).toEqual({ error: "messages must be a non-empty array" });
    expect(toBridgeRequest({ model: "m", messages: [] })).toEqual({ error: "messages must be a non-empty array" });
  });

  it("reads the system prompt from a string or text blocks, ignoring cache_control", () => {
    expect(
      project(request({ model: "m", messages: [{ role: "user", content: "hi" }], system: "be brief" })).context
        .systemPrompt,
    ).toBe("be brief");
    expect(
      project(
        request({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          system: [
            { type: "text", text: "first", cache_control: { type: "ephemeral" } },
            { type: "text", text: "second" },
          ],
        }),
      ).context.systemPrompt,
    ).toBe("first\n\nsecond");
    expect(
      project(request({ model: "m", messages: [{ role: "user", content: "hi" }] })).context.systemPrompt,
    ).toBeUndefined();
  });

  it("pairs tool results with the earlier tool_use for names, results first then the remaining text", () => {
    const out = project(
      request({
        model: "m",
        messages: [
          { role: "user", content: "run" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "c2", name: "Read", input: { file_path: "/tmp/a" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c1", content: "out" },
              { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: "file" }], is_error: true },
              { type: "text", text: "continue" },
            ],
          },
        ],
      }),
    );
    expect(out.context.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "run" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "toolCall", id: "c1", name: "Bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "c2", name: "Read", arguments: { file_path: "/tmp/a" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "Bash",
        content: [{ type: "text", text: "out" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "Read",
        content: [{ type: "text", text: "file" }],
        isError: true,
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("leaves the tool name empty for an id no assistant turn declared", () => {
    const out = project(
      request({
        model: "m",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "out" }] }],
      }),
    );
    expect(out.context.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: "ghost",
        toolName: "",
        content: [{ type: "text", text: "out" }],
        isError: false,
      },
    ]);
  });

  it("drops a user message that carried only tool results", () => {
    const out = project(
      request({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c1", content: "out" },
              { type: "tool_result", tool_use_id: "c1", content: "again" },
            ],
          },
        ],
      }),
    );
    expect(out.context.messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
  });

  it("maps images: base64 to bytes, urls to a placeholder", () => {
    const out = project(
      request({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
              { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
            ],
          },
        ],
      }),
    );
    expect(out.context.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "[image: https://example.com/a.png]" },
        ],
      },
    ]);
  });

  it("carries thinking signatures and drops redacted thinking", () => {
    const out = project(
      request({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig" },
              { type: "redacted_thinking", data: "enc" },
              { type: "thinking", thinking: "more", signature: "" },
            ],
          },
          { role: "user", content: "go" },
        ],
      }),
    );
    expect(out.context.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
          { type: "thinking", thinking: "more" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ]);
  });

  it("reads string assistant content as one text block and drops empty assistant turns", () => {
    const out = project(
      request({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "assistant", content: [] },
          { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
          { role: "assistant", content: "" },
        ],
      }),
    );
    expect(out.context.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("keeps a tool call whose arguments are not an object with empty arguments", () => {
    const out = project(
      request({
        model: "m",
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: "ls" }] }],
      }),
    );
    expect(out.context.messages).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "Bash", arguments: {} }] },
    ]);
  });

  it("maps custom tools and skips server tools without a schema", () => {
    const out = project(
      request({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "Bash", description: "run", input_schema: { type: "object" } },
          { type: "custom", name: "Edit", input_schema: { type: "object" } },
          { type: "web_search_20250305", name: "web_search" },
          { name: "NoSchema" },
        ],
      }),
    );
    expect(out.context.tools).toEqual([
      { name: "Bash", description: "run", parameters: { type: "object" } },
      { name: "Edit", description: "", parameters: { type: "object" } },
    ]);
  });

  it("sends no tools key when the request declares none", () => {
    expect(project(request({ model: "m", messages: [{ role: "user", content: "hi" }] })).context.tools).toBeUndefined();
    expect(
      project(request({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] })).context.tools,
    ).toBeUndefined();
  });

  it("reads effort from output_config, then falls back to the thinking budget", () => {
    const effort = (thinking: unknown, outputConfig?: unknown) =>
      project(
        request({ model: "m", messages: [{ role: "user", content: "hi" }], thinking, output_config: outputConfig }),
      ).effort;
    expect(effort({ type: "enabled", budget_tokens: 2048 }, { effort: "xhigh" })).toBe("xhigh");
    expect(effort({ type: "enabled", budget_tokens: 2048 }, { effort: "minimal" })).toBe("minimal");
    expect(effort({ type: "enabled", budget_tokens: 2048 })).toBe("low");
    expect(effort({ type: "enabled", budget_tokens: 4096 })).toBe("medium");
    expect(effort({ type: "enabled", budget_tokens: 16384 })).toBe("high");
    expect(effort({ type: "enabled", budget_tokens: 99999 })).toBe("high");
    expect(effort({ type: "adaptive" })).toBe("high");
    expect(effort({ type: "adaptive" }, { effort: "nope" })).toBe("high");
    expect(effort({ type: "disabled" })).toBeUndefined();
    expect(effort({ type: "enabled" })).toBeUndefined();
    expect(effort(undefined)).toBeUndefined();
  });

  it("ignores fields the neutral vocabulary has no slot for", () => {
    const out = project(
      request({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
        top_p: 1,
        top_k: 40,
        tool_choice: { type: "auto" },
        metadata: { user_id: "u" },
        stop_sequences: ["END"],
      }),
    );
    expect(out.maxTokens).toBeUndefined();
    expect(out.stream).toBe(false);
    expect(out.effort).toBeUndefined();
  });
});

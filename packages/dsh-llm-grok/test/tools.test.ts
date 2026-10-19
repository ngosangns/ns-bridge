import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { createMessagesParseState, parseGrokMessagesLine } from "../src/messages.js";
import { createToolChunkTranslator, translateGrokToolCall } from "../src/tools.js";

const tools: ToolSchema[] = [
  {
    name: "read",
    description: "",
    parameters: { type: "object", properties: { file_path: {}, offset: {}, limit: {} }, required: ["file_path"] },
  },
  {
    name: "bash",
    description: "",
    parameters: { type: "object", properties: { command: {}, description: {} }, required: ["command"] },
  },
  {
    name: "edit",
    description: "",
    parameters: {
      type: "object",
      properties: { file_path: {}, old_string: {}, new_string: {}, replace_all: {} },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description: "",
    parameters: { type: "object", properties: { pattern: {}, path: {}, include: {} }, required: ["pattern"] },
  },
  {
    name: "write",
    description: "",
    parameters: { type: "object", properties: { file_path: {}, content: {} }, required: ["file_path", "content"] },
  },
];

describe("grok tool translation", () => {
  it("rewrites CLI coding tools onto harness tools", () => {
    expect(translateGrokToolCall("read_file", '{"target_file":"a.ts","offset":2,"limit":10}', tools)).toEqual({
      name: "read",
      arguments: '{"file_path":"a.ts","offset":2,"limit":10}',
    });
    expect(translateGrokToolCall("list_dir", '{"target_directory":"/tmp/a\'b"}', tools)).toEqual({
      name: "bash",
      arguments: JSON.stringify({ command: `ls -la '/tmp/a'"'"'b'`, description: "List directory" }),
    });
    expect(
      translateGrokToolCall("run_terminal_command", '{"command":"pwd","description":"Print working directory"}', tools),
    ).toEqual({
      name: "bash",
      arguments: '{"command":"pwd","description":"Print working directory"}',
    });
    expect(
      translateGrokToolCall(
        "search_replace",
        '{"file_path":"a.ts","old_string":"x","new_string":"y","replace_all":true}',
        tools,
      ),
    ).toEqual({
      name: "edit",
      arguments: '{"file_path":"a.ts","old_string":"x","new_string":"y","replace_all":true}',
    });
    expect(translateGrokToolCall("grep", '{"pattern":"foo","path":"src","glob":"*.ts","head_limit":5}', tools)).toEqual(
      {
        name: "grep",
        arguments: '{"pattern":"foo","path":"src","include":"*.ts"}',
      },
    );
    expect(translateGrokToolCall("write", '{"file_path":"a.ts","content":"hi","extra":1}', tools)).toEqual({
      name: "write",
      arguments: '{"file_path":"a.ts","content":"hi"}',
    });
  });

  it("turns an unknown tool into text", () => {
    const translated = translateGrokToolCall("list_agents", "{}", tools);
    expect(translated).toEqual({
      text: 'Tool "list_agents" is not available in DeepSeek Harness. Use read, grep, bash, edit, or write.',
    });
  });

  it("finishes with stop when every tool call was rejected", () => {
    const state = createMessagesParseState();
    const translator = createToolChunkTranslator(tools);
    const lines = [
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"list_agents","input":{}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '{"type":"message_stop"}',
    ];
    const chunks = lines.flatMap((line) =>
      parseGrokMessagesLine(line, state).flatMap((chunk) => translator.push(chunk)),
    );
    expect(chunks.some((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")).toBe(false);
    expect(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text.includes("list_agents"))).toBe(true);
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
  });

  it("keeps a translated call and finishes with tool-calls", () => {
    const state = createMessagesParseState();
    const translator = createToolChunkTranslator(tools);
    const lines = [
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"target_file\\":\\"a.ts\\"}"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '{"type":"message_stop"}',
    ];
    const chunks = lines.flatMap((line) =>
      parseGrokMessagesLine(line, state).flatMap((chunk) => translator.push(chunk)),
    );
    expect(chunks).toContainEqual({
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: "toolu_1", name: "read", arguments: '{"file_path":"a.ts"}' },
    });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });
});

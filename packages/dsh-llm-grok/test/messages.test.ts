import { describe, expect, it } from "vitest";
import { buildGrokCliArgs, resolveGrokBinary } from "../src/cli.js";
import { createMessagesParseState, parseGrokMessagesLine } from "../src/messages.js";
import { buildGrokPrompt } from "../src/prompt.js";

const LINES = [
  '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
  '{"type":"content_block_stop","index":0}',
  '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}',
  '{"type":"content_block_stop","index":1}',
  '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}',
  '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
  '{"type":"content_block_stop","index":2}',
  '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
  '{"type":"message_stop"}',
];

describe("grok CLI stream mapping", () => {
  it("maps thinking, text, and tool JSON onto harness chunks", () => {
    const state = createMessagesParseState();
    const chunks = LINES.flatMap((line) => parseGrokMessagesLine(line, state));
    expect(chunks).toContainEqual({ type: "reasoning-delta", index: 0, text: "hmm" });
    expect(chunks).toContainEqual({ type: "text-delta", index: 1, text: "hello" });
    expect(chunks).toContainEqual({
      type: "tool-call-delta",
      index: 2,
      id: "toolu_1",
      name: "bash",
      argumentsDelta: '{"cmd":"ls"}',
    });
    expect(chunks).toContainEqual({
      type: "block-end",
      index: 2,
      block: { type: "tool-call", id: "toolu_1", name: "bash", arguments: '{"cmd":"ls"}' },
    });
    expect(chunks.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 3, outputTokens: 8 } });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });

  it("shows the whole assistant message the CLI sends when partials are off", () => {
    const state = createMessagesParseState();
    const lines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":1,"cache_read_input_tokens":2}}}',
      '{"type":"result","is_error":false,"result":"hi","stop_reason":"end_turn"}',
    ];
    const chunks = lines.flatMap((line) => parseGrokMessagesLine(line, state));
    const text = chunks.filter((chunk) => chunk.type === "text-delta");
    expect(text).toEqual([{ type: "text-delta", index: 0, text: "hi" }]);
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2 },
    });
  });

  it("streams wrapped partials once and keeps the later assistant copy", () => {
    const state = createMessagesParseState();
    const lines = [
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","is_error":false,"result":"hi","stop_reason":"end_turn"}',
    ];
    const chunks = lines.flatMap((line) => parseGrokMessagesLine(line, state));
    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toEqual([
      { type: "text-delta", index: 0, text: "hi" },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
  });

  it("maps end_turn and max_tokens", () => {
    for (const [stop, kind] of [
      ["end_turn", "stop"],
      ["max_tokens", "max-tokens"],
    ] as const) {
      const state = createMessagesParseState();
      const chunks = [
        `{"type":"message_delta","delta":{"stop_reason":${JSON.stringify(stop)}}}`,
        '{"type":"message_stop"}',
      ].flatMap((line) => parseGrokMessagesLine(line, state));
      expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind } });
    }
  });

  it("builds a one-turn command without tool approval", () => {
    const args = buildGrokCliArgs({ prompt: "hi", model: "grok-4.5-agent", reasoningEffort: "high" });
    expect(args).toEqual([
      "--single",
      "hi",
      "--output-format",
      "streaming-messages-json",
      "--include-partial-messages",
      "--model",
      "grok-4.5",
      "--max-turns",
      "1",
      "--no-plan",
      "--no-subagents",
      "--reasoning-effort",
      "high",
    ]);
    expect(args).not.toContain("--always-approve");
  });

  it("puts system text and tool calls in the prompt", () => {
    const prompt = buildGrokPrompt({
      system: "Be brief",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: '{"cmd":"ls"}' }] },
        { role: "tool", content: [{ type: "text", text: "file.txt" }] },
      ],
    });
    expect(prompt).toContain("Be brief");
    expect(prompt).toContain("hi");
    expect(prompt).toContain('bash {"cmd":"ls"}');
    expect(prompt).toContain("file.txt");
  });

  it("uses an explicit binary path", () => {
    expect(resolveGrokBinary({ GROK_BIN: process.execPath })).toBe(process.execPath);
    expect(() => resolveGrokBinary({ GROK_BIN: "/no/such/grok" })).toThrow(/not executable/);
  });
});

import { describe, expect, it } from "vitest";
import { buildGrokCliArgs, resolveGrokBinary, resumesGrokSession } from "../src/cli.js";
import { createMessagesParseState, grokTurnSucceeded, parseGrokMessagesLine } from "../src/messages.js";
import {
  buildGrokAcpContent,
  GROK_INLINE_USER_QUERY_BYTES,
  grokUserQueryByteLength,
  planGrokPrompt,
} from "../src/prompt.js";

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
    const args = buildGrokCliArgs({
      promptFile: "/tmp/prompt.json",
      model: "grok-4.5-agent",
      reasoningEffort: "high",
    });
    expect(args).toEqual([
      "--prompt-file",
      "/tmp/prompt.json",
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
    expect(args).not.toContain("--single");
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("--resume");
    expect(args.join(" ")).not.toContain("base64");
  });

  it("resumes a chat and leaves compaction off that session", () => {
    const id = "03910d0e-5f6c-4474-85c3-6116a4503e17";
    const resumed = buildGrokCliArgs({ promptFile: "/tmp/prompt.json", model: "grok-4.7", resume: id });
    expect(resumed).toContain("--resume");
    expect(resumed).toContain(id);
    expect(resumed).not.toContain("--session-id");
    const created = buildGrokCliArgs({ promptFile: "/tmp/prompt.json", model: "grok-4.7", sessionId: id });
    expect(created).toContain("--session-id");
    expect(created).not.toContain("--resume");
    expect(resumesGrokSession(undefined)).toBe(true);
    expect(resumesGrokSession("compaction")).toBe(false);
    expect(resumesGrokSession("session-title")).toBe(false);
  });

  it("keeps a max-turns tool call resumable after message_stop", () => {
    const state = createMessagesParseState();
    const chunks = [
      ...LINES,
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"again"}]}}',
      '{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"max_turn_requests"}',
    ].flatMap((line) => parseGrokMessagesLine(line, state));
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
    expect(state.maxTurnsReached).toBe(true);
    expect(state.finished).toBe(true);
    expect(
      grokTurnSucceeded({
        code: 1,
        spawnFailed: false,
        maxTurnsReached: state.maxTurnsReached,
        producedOutput: state.sawStreamBlocks,
      }),
    ).toBe(true);
    expect(grokTurnSucceeded({ code: 1, spawnFailed: false, maxTurnsReached: false, producedOutput: true })).toBe(
      false,
    );
    expect(grokTurnSucceeded({ code: 1, spawnFailed: false, maxTurnsReached: true, producedOutput: false })).toBe(
      false,
    );
    expect(grokTurnSucceeded({ code: 0, spawnFailed: true, maxTurnsReached: false, producedOutput: true })).toBe(false);
  });

  it("sends only the new tool result when the grok session already has the prefix", () => {
    const first = planGrokPrompt({
      system: "Be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "make a dropdown" }] }],
    });
    expect(first.mode).toBe("full");
    const next = planGrokPrompt(
      {
        system: "Be brief",
        messages: [
          { role: "user", content: [{ type: "text", text: "make a dropdown" }] },
          {
            role: "assistant",
            content: [{ type: "tool-call", name: "read", arguments: '{"file_path":"SidebarView.swift"}' }],
          },
          { role: "tool", content: [{ type: "text", text: "struct SidebarView" }] },
        ],
      },
      { count: first.count, fingerprint: first.fingerprint },
    );
    expect(next.mode).toBe("delta");
    const joined = next.input.messages
      .flatMap((message) => message.content ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    const rendered = buildGrokAcpContent(next.input)
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(joined).toBe("struct SidebarView");
    expect(rendered).toContain("struct SidebarView");
    expect(rendered).not.toContain("make a dropdown");
    expect(rendered).not.toContain("Be brief");
    expect(rendered).not.toContain("SidebarView.swift");
  });

  it("sends the transcript again when an earlier message changes", () => {
    const first = planGrokPrompt({
      messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
    });
    const changed = planGrokPrompt(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "replaced" }] },
          { role: "tool", content: [{ type: "text", text: "result" }] },
        ],
      },
      { count: first.count, fingerprint: first.fingerprint },
    );
    expect(changed.mode).toBe("full");
    expect(changed.input.messages).toHaveLength(2);
  });

  it("puts system text, tool calls, and images into ACP in order", () => {
    const content = buildGrokAcpContent({
      system: "Be brief",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "AAAA", mimeType: "image/png", placeholder: "dropped" },
            { type: "image", placeholder: "offloaded one" },
          ],
        },
        { role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: '{"cmd":"ls"}' }] },
        { role: "tool", content: [{ type: "text", text: "file.txt" }] },
      ],
    });
    expect(content).toEqual([
      { type: "text", text: "Be brief" },
      { type: "text", text: "User:\nhi\noffloaded one" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: 'Assistant:\nbash {"cmd":"ls"}' },
      { type: "text", text: "Tool:\nfile.txt" },
    ]);
  });

  it("keeps assistant reasoning off the prompt so the host thinking card owns it", () => {
    const content = buildGrokAcpContent({
      messages: [
        { role: "user", content: [{ type: "text", text: "make a dropdown" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I will read SidebarView and then edit it." },
            { type: "text", text: "Mình đọc sidebar." },
          ],
        },
      ],
    });
    const joined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    expect(joined).toContain("Mình đọc sidebar.");
    expect(joined).not.toContain("SidebarView");
  });

  it("drops a read of the Grok prompt file so the next turn does not grow", () => {
    const path =
      "/Users/ngosangns/.grok/sessions/%2FUsers%2Fngosangns%2F.dsh%2Fprofiles%2Fdesktop/abc/prompts/prompt_0.txt";
    const content = buildGrokAcpContent({
      messages: [
        { role: "user", content: [{ type: "text", text: "workspace dropdown" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", name: "read", arguments: JSON.stringify({ file_path: path }) }],
        },
        {
          role: "tool",
          content: [{ type: "text", text: `<path>${path}</path>\n<content>\n${"line\n".repeat(5000)}</content>` }],
        },
      ],
    });
    const tool = content.find((block) => block.type === "text" && block.text.startsWith("Tool:"));
    expect(tool).toMatchObject({ type: "text" });
    if (tool?.type !== "text") return;
    expect(tool.text).toContain("Do not read that file");
    expect(tool.text).not.toContain("<content>");
    expect(content.some((block) => block.type === "text" && block.text.includes("workspace dropdown"))).toBe(true);
    expect(grokUserQueryByteLength(content)).toBeLessThan(GROK_INLINE_USER_QUERY_BYTES);
  });

  it("drops older turns so the newest tool result stays whole", () => {
    const content = buildGrokAcpContent({
      messages: [
        { role: "user", content: [{ type: "text", text: "keep this user request intact" }] },
        { role: "tool", content: [{ type: "text", text: `OLD ${"x".repeat(120_000)}` }] },
        { role: "tool", content: [{ type: "text", text: "newest tool result" }] },
      ],
    });
    const joined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    expect(joined).toContain("keep this user request intact");
    expect(joined).toContain("newest tool result");
    expect(joined).not.toContain("OLD ");
    expect(joined).toContain("Earlier turns were omitted");
    expect(grokUserQueryByteLength(content)).toBeLessThanOrEqual(GROK_INLINE_USER_QUERY_BYTES);
  });

  it("keeps the newest file body when stubbing every tool would still exceed the limit", () => {
    const newest = `${"y".repeat(1_500)}UNIQUE-FULL-RESULT${"z".repeat(1_500)}`;
    const messages = [{ role: "user", content: [{ type: "text", text: "workspace dropdown" }] }];
    for (let i = 0; i < 80; i++) {
      messages.push({ role: "assistant", content: [{ type: "text", text: `step ${i} ${"A".repeat(1_000)}` }] });
      messages.push({ role: "tool", content: [{ type: "text", text: `old-result-${i} ${"B".repeat(5_000)}` }] });
    }
    messages.push({ role: "tool", content: [{ type: "text", text: newest }] });
    const content = buildGrokAcpContent({ messages });
    const joined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    expect(joined).toContain("workspace dropdown");
    expect(joined).toContain(newest);
    expect(joined).not.toContain("step 0 ");
    expect(grokUserQueryByteLength(content)).toBeLessThanOrEqual(GROK_INLINE_USER_QUERY_BYTES);
  });

  it("trims a tool result only when that result alone exceeds the inline limit", () => {
    const content = buildGrokAcpContent({
      messages: [
        { role: "user", content: [{ type: "text", text: "keep this user request intact" }] },
        { role: "tool", content: [{ type: "text", text: `ONLY ${"x".repeat(120_000)}` }] },
      ],
    });
    const joined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    expect(joined).toContain("keep this user request intact");
    expect(joined).toContain("older tool output omitted");
    expect(joined).not.toContain("x".repeat(120_000));
    expect(grokUserQueryByteLength(content)).toBeLessThanOrEqual(GROK_INLINE_USER_QUERY_BYTES);
  });

  it("uses an explicit binary path", () => {
    expect(resolveGrokBinary({ GROK_BIN: process.execPath })).toBe(process.execPath);
    expect(() => resolveGrokBinary({ GROK_BIN: "/no/such/grok" })).toThrow(/not executable/);
  });
});

// ABOUTME: Tests for mapping model-invented tool names onto tools the host declared.
// ABOUTME: Covers upstream's alias table plus the declared-tools guard this port adds.

import { describe, expect, it } from "vitest";
import { normalizeToolName, withDeclaredToolNames } from "../src/tool-names.js";
import type { BridgeStreamEvent } from "../src/types.js";

/** The built-ins pi/OMP register, which upstream's aliases target. */
const PI_TOOLS = new Set(["read", "write", "edit", "ls", "find", "bash", "grep"]);

describe("normalizeToolName", () => {
  it("maps read, write and edit aliases onto declared built-ins", () => {
    expect(normalizeToolName("read_file", PI_TOOLS)).toBe("read");
    expect(normalizeToolName("fs_read", PI_TOOLS)).toBe("read");
    expect(normalizeToolName("view_file", PI_TOOLS)).toBe("read");
    expect(normalizeToolName("write_file", PI_TOOLS)).toBe("write");
    expect(normalizeToolName("create_file", PI_TOOLS)).toBe("write");
    expect(normalizeToolName("str_replace_editor", PI_TOOLS)).toBe("edit");
    expect(normalizeToolName("str_replace_based_edit_tool", PI_TOOLS)).toBe("edit");
    expect(normalizeToolName("apply_patch", PI_TOOLS)).toBe("edit");
  });

  it("maps directory aliases and leaves ambiguous names alone", () => {
    expect(normalizeToolName("list_directory", PI_TOOLS)).toBe("ls");
    expect(normalizeToolName("file_search", PI_TOOLS)).toBe("find");
    for (const name of ["shell", "search", "glob", "terminal", "run_command"]) {
      expect(normalizeToolName(name, PI_TOOLS)).toBe(name);
    }
  });

  it("is case-insensitive on the alias key", () => {
    expect(normalizeToolName("Read_File", PI_TOOLS)).toBe("read");
    expect(normalizeToolName("WRITE_FILE", PI_TOOLS)).toBe("write");
  });

  it("never rewrites a name the host itself declared", () => {
    // An MCP server or another host may register its own `read_file`.
    expect(normalizeToolName("read_file", new Set(["read", "read_file"]))).toBe("read_file");
  });

  it("leaves the name alone when the alias target is not declared", () => {
    expect(normalizeToolName("read_file", new Set(["fs.read", "shell"]))).toBe("read_file");
  });

  it("leaves the name alone when the host declared no tools", () => {
    expect(normalizeToolName("read_file", undefined)).toBe("read_file");
    expect(normalizeToolName("read_file", new Set())).toBe("read_file");
  });

  it("passes unknown and custom names through unchanged", () => {
    expect(normalizeToolName("mcp__server__do_thing", PI_TOOLS)).toBe("mcp__server__do_thing");
    expect(normalizeToolName("some_custom_tool", PI_TOOLS)).toBe("some_custom_tool");
  });
});

describe("withDeclaredToolNames", () => {
  async function collect(events: BridgeStreamEvent[], names: string[] | undefined): Promise<BridgeStreamEvent[]> {
    const source = (async function* () {
      yield* events;
    })();
    const tools = names?.map((name) => ({ name, description: "", parameters: {} }));
    const out: BridgeStreamEvent[] = [];
    for await (const event of withDeclaredToolNames(source, tools)) out.push(event);
    return out;
  }

  const call: BridgeStreamEvent[] = [
    { type: "tool_call_start", index: 0, id: "t1", name: "read_file" },
    { type: "tool_call_delta", index: 0, id: "t1", argumentsDelta: "{}" },
    { type: "tool_call_end", index: 0, id: "t1", name: "read_file", arguments: {} },
    { type: "done", stopReason: "toolUse" },
  ];

  it("renames the start and end of a call onto the declared tool", async () => {
    const out = await collect(call, ["read", "bash"]);
    expect(out.filter((e) => e.type === "tool_call_start" || e.type === "tool_call_end")).toEqual([
      { type: "tool_call_start", index: 0, id: "t1", name: "read" },
      { type: "tool_call_end", index: 0, id: "t1", name: "read", arguments: {} },
    ]);
    expect(out).toHaveLength(4);
  });

  it("leaves the stream alone when the name is declared or no tools are", async () => {
    expect(await collect(call, ["read_file", "read"])).toEqual(call);
    expect(await collect(call, undefined)).toEqual(call);
    expect(await collect(call, [])).toEqual(call);
  });
});

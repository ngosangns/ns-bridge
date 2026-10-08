// ABOUTME: Tests for mapping model-invented tool names onto tools the host declared.
// ABOUTME: Covers upstream's alias table plus the declared-tools guard this port adds.

import { describe, expect, it } from "vitest";
import { normalizeKiroToolName } from "../src/tool-name-aliases.js";

/** The built-ins pi/OMP register, which upstream's aliases target. */
const PI_TOOLS = new Set(["read", "write", "edit", "ls", "find", "bash", "grep"]);

describe("normalizeKiroToolName", () => {
  it("maps read, write and edit aliases onto declared built-ins", () => {
    expect(normalizeKiroToolName("read_file", PI_TOOLS)).toBe("read");
    expect(normalizeKiroToolName("fs_read", PI_TOOLS)).toBe("read");
    expect(normalizeKiroToolName("view_file", PI_TOOLS)).toBe("read");
    expect(normalizeKiroToolName("write_file", PI_TOOLS)).toBe("write");
    expect(normalizeKiroToolName("create_file", PI_TOOLS)).toBe("write");
    expect(normalizeKiroToolName("str_replace_editor", PI_TOOLS)).toBe("edit");
    expect(normalizeKiroToolName("str_replace_based_edit_tool", PI_TOOLS)).toBe("edit");
    expect(normalizeKiroToolName("apply_patch", PI_TOOLS)).toBe("edit");
  });

  it("maps directory aliases and leaves ambiguous names alone", () => {
    expect(normalizeKiroToolName("list_directory", PI_TOOLS)).toBe("ls");
    expect(normalizeKiroToolName("file_search", PI_TOOLS)).toBe("find");
    for (const name of ["shell", "search", "glob", "terminal", "run_command"]) {
      expect(normalizeKiroToolName(name, PI_TOOLS)).toBe(name);
    }
  });

  it("is case-insensitive on the alias key", () => {
    expect(normalizeKiroToolName("Read_File", PI_TOOLS)).toBe("read");
    expect(normalizeKiroToolName("WRITE_FILE", PI_TOOLS)).toBe("write");
  });

  it("never rewrites a name the host itself declared", () => {
    // An MCP server or another host may register its own `read_file`.
    expect(normalizeKiroToolName("read_file", new Set(["read", "read_file"]))).toBe("read_file");
  });

  it("leaves the name alone when the alias target is not declared", () => {
    expect(normalizeKiroToolName("read_file", new Set(["fs.read", "shell"]))).toBe("read_file");
  });

  it("leaves the name alone when the host declared no tools", () => {
    expect(normalizeKiroToolName("read_file", undefined)).toBe("read_file");
    expect(normalizeKiroToolName("read_file", new Set())).toBe("read_file");
  });

  it("passes unknown and custom names through unchanged", () => {
    expect(normalizeKiroToolName("mcp__server__do_thing", PI_TOOLS)).toBe("mcp__server__do_thing");
    expect(normalizeKiroToolName("some_custom_tool", PI_TOOLS)).toBe("some_custom_tool");
  });
});

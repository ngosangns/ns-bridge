// ABOUTME: Maps tool names a model invented from its training prior onto tools the host declared.
// ABOUTME: Host translation, so it lives in the bridge: a vendor core reports what the wire said.

import type { BridgeStreamEvent, BridgeTool } from "./types.js";

/**
 * Tool names Claude-class models substitute for the ones the request declared
 * (`read_file` for `read`, `str_replace_editor` for `edit`, …). Ported from
 * upstream pi-provider-kiro (#163), where the model routinely ignores the
 * advertised tool names and the host then rejects the call with
 * "Tool <name> not found", so the file operation silently does nothing.
 *
 * Scope is deliberately narrow: only unambiguous file-operation aliases. Names
 * a session might legitimately register as a distinct tool — `shell`,
 * `search`, `glob`, `terminal` — are intentionally absent.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // read
  read_file: "read",
  readfile: "read",
  fs_read: "read",
  view_file: "read",
  // write
  write_file: "write",
  writefile: "write",
  fs_write: "write",
  create_file: "write",
  // edit
  edit_file: "edit",
  editfile: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  str_replace_based_edit_tool: "edit",
  apply_patch: "edit",
  // ls
  list_directory: "ls",
  list_dir: "ls",
  list_files: "ls",
  // find
  find_files: "find",
  file_search: "find",
};

/**
 * Resolve a model-emitted tool name against the tools the host declared.
 *
 * A name is rewritten only when
 *   1. the host declared tools at all,
 *   2. the emitted name is NOT one of them, and
 *   3. the alias target IS one of them.
 * Anything else passes through unchanged, so a host that registers its own
 * `read_file` (an MCP server, the DeepSeek Harness) keeps it. Alias keys match
 * case-insensitively.
 */
export function normalizeToolName(name: string, declared: ReadonlySet<string> | undefined): string {
  if (!declared || declared.size === 0 || declared.has(name)) return name;
  const alias = TOOL_NAME_ALIASES[name.toLowerCase()];
  return alias !== undefined && declared.has(alias) ? alias : name;
}

/**
 * Rename tool calls in a neutral event stream onto the tools the request
 * declared. With no declared tools the stream is returned untouched.
 */
export function withDeclaredToolNames(
  events: AsyncIterable<BridgeStreamEvent>,
  tools: readonly BridgeTool[] | undefined,
): AsyncIterable<BridgeStreamEvent> {
  if (!tools || tools.length === 0) return events;
  const declared = new Set(tools.map((tool) => String(tool.name)));
  return (async function* () {
    for await (const event of events) {
      if (event.type === "tool_call_start" || event.type === "tool_call_end") {
        const name = normalizeToolName(event.name, declared);
        yield name === event.name ? event : { ...event, name };
      } else {
        yield event;
      }
    }
  })();
}

/**
 * Grok CLI tool calls use the CLI's own names. The harness executes the call,
 * so each name and argument object is rewritten onto a harness tool first.
 * A name the harness does not list becomes text, which keeps the turn from
 * retrying `ToolNotFoundError`.
 */

import { type StreamChunk, ToolCallId, type ToolSchema } from "@deepseek-ai/dsh-llm";

export interface TranslatedToolCall {
  readonly name: string;
  readonly arguments: string;
}

const CODING_TOOLS = new Set(["read", "grep", "bash", "edit", "write"]);

function unsupported(name: string): { text: string } {
  return {
    text: `Tool "${name}" is not available in DeepSeek Harness. Use read, grep, bash, edit, or write.`,
  };
}

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function propertyKeys(tool: ToolSchema | undefined): Set<string> | undefined {
  const properties = tool?.parameters?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return new Set(Object.keys(properties as Record<string, unknown>));
}

function pickArgs(args: Record<string, unknown>, tool: ToolSchema | undefined): Record<string, unknown> {
  const keys = propertyKeys(tool);
  if (!keys) return args;
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (keys.has(key)) picked[key] = value;
  }
  return picked;
}

function findTool(name: string, tools: readonly ToolSchema[] | undefined): ToolSchema | undefined {
  if (tools) return tools.find((tool) => tool.name === name);
  if (!CODING_TOOLS.has(name)) return undefined;
  return { name, description: "", parameters: {} };
}

interface ShapedCall {
  name: string;
  args: Record<string, unknown>;
  /** Parsed JSON was not required; the raw argument string may pass through. */
  passthrough?: boolean;
}

function shapeCall(name: string, args: Record<string, unknown> | undefined): ShapedCall | { text: string } {
  if (name === "read_file") {
    const file = args ? stringField(args, "target_file") : undefined;
    if (!file) return unsupported(name);
    const next: Record<string, unknown> = { file_path: file };
    if (typeof args?.offset === "number") next.offset = args.offset;
    if (typeof args?.limit === "number") next.limit = args.limit;
    return { name: "read", args: next };
  }
  if (name === "list_dir") {
    if (!args) return unsupported(name);
    const dir = stringField(args, "target_directory") ?? ".";
    return {
      name: "bash",
      args: { command: `ls -la ${shellQuote(dir)}`, description: "List directory" },
    };
  }
  if (name === "run_terminal_command") {
    const command = args ? stringField(args, "command") : undefined;
    if (!command) return unsupported(name);
    const next: Record<string, unknown> = { command };
    const description = stringField(args ?? {}, "description");
    if (description) next.description = description;
    return { name: "bash", args: next };
  }
  if (name === "search_replace") {
    const file = args ? stringField(args, "file_path") : undefined;
    const oldString = args && typeof args.old_string === "string" ? args.old_string : undefined;
    const newString = args && typeof args.new_string === "string" ? args.new_string : undefined;
    if (!file || oldString === undefined || newString === undefined) return unsupported(name);
    const next: Record<string, unknown> = { file_path: file, old_string: oldString, new_string: newString };
    if (typeof args?.replace_all === "boolean") next.replace_all = args.replace_all;
    return { name: "edit", args: next };
  }
  if (name === "grep") {
    const pattern = args ? stringField(args, "pattern") : undefined;
    if (!pattern) return unsupported(name);
    const next: Record<string, unknown> = { pattern };
    const path = stringField(args ?? {}, "path");
    if (path) next.path = path;
    const include = stringField(args ?? {}, "glob") ?? stringField(args ?? {}, "include");
    if (include) next.include = include;
    return { name: "grep", args: next };
  }
  if (!args) return { name, args: {}, passthrough: true };
  return { name, args, passthrough: true };
}

/** Rewrite one CLI tool call onto the harness tool list. */
export function translateGrokToolCall(
  name: string,
  argumentsJson: string,
  tools: readonly ToolSchema[] | undefined,
): TranslatedToolCall | { text: string } {
  const parsed = parseArgs(argumentsJson);
  const shaped = shapeCall(name, parsed);
  if ("text" in shaped) return shaped;
  const tool = findTool(shaped.name, tools);
  if (!tool) return unsupported(name);
  if (!parsed && shaped.passthrough) {
    return { name: shaped.name, arguments: argumentsJson.length > 0 ? argumentsJson : "{}" };
  }
  return { name: shaped.name, arguments: JSON.stringify(pickArgs(shaped.args, tool)) };
}

interface HeldTool {
  id?: ReturnType<typeof ToolCallId>;
  name: string;
  arguments: string;
}

/**
 * Hold each tool-call block until it closes, then emit the translated call.
 * `tool-calls` becomes `stop` when every call was rewritten to text.
 */
export function createToolChunkTranslator(tools: readonly ToolSchema[] | undefined): {
  push(chunk: StreamChunk): StreamChunk[];
} {
  const held = new Map<number, HeldTool>();
  let sawCall = false;

  function emitHeld(index: number, blockArguments: string, blockName: string, blockId: HeldTool["id"]): StreamChunk[] {
    const open = held.get(index);
    held.delete(index);
    const name = blockName || open?.name || "tool";
    const args = blockArguments || open?.arguments || "{}";
    const translated = translateGrokToolCall(name, args, tools);
    if ("text" in translated) {
      return [
        { type: "block-start", index, blockType: "text" },
        { type: "text-delta", index, text: translated.text },
        { type: "block-end", index, block: { type: "text", text: translated.text } },
      ];
    }
    sawCall = true;
    const callId = ToolCallId(blockId ?? open?.id ?? `grok-tool-${index}`);
    return [
      { type: "block-start", index, blockType: "tool-call" },
      {
        type: "tool-call-delta",
        index,
        id: callId,
        name: translated.name,
        argumentsDelta: translated.arguments,
      },
      {
        type: "block-end",
        index,
        block: { type: "tool-call", id: callId, name: translated.name, arguments: translated.arguments },
      },
    ];
  }

  return {
    push(chunk: StreamChunk): StreamChunk[] {
      if (chunk.type === "block-start" && chunk.blockType === "tool-call") {
        held.set(chunk.index, { name: "", arguments: "" });
        return [];
      }
      if (chunk.type === "tool-call-delta" && held.has(chunk.index)) {
        const open = held.get(chunk.index);
        if (open) {
          open.id = chunk.id;
          if (chunk.name) open.name = chunk.name;
          open.arguments += chunk.argumentsDelta;
        }
        return [];
      }
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
        if (!held.has(chunk.index)) {
          held.set(chunk.index, { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments });
        }
        return emitHeld(chunk.index, chunk.block.arguments, chunk.block.name, chunk.block.id);
      }
      if (chunk.type === "finish") {
        const flushed: StreamChunk[] = [];
        for (const [index, open] of held) {
          flushed.push(...emitHeld(index, open.arguments, open.name, open.id));
        }
        held.clear();
        if (chunk.reason.kind === "tool-calls" && !sawCall) {
          flushed.push({ type: "finish", reason: { kind: "stop" } });
          return flushed;
        }
        flushed.push(chunk);
        return flushed;
      }
      return [chunk];
    },
  };
}

// ABOUTME: Projects a Pi-family (Pi 1.x or OMP) request context onto the neutral one the vendor cores read.
// ABOUTME: One direction only — responses travel back as stream events, not messages.

import type {
  BridgeAssistantContent,
  BridgeContext,
  BridgeMessage,
  BridgeStopReason,
  BridgeTool,
  BridgeUserContent,
} from "../types.js";
import { getCurrentSystemPrompt, getCurrentTools } from "./transcript.js";

/** The parts of a Pi / OMP message this bridge reads; both hosts' message unions satisfy it. */
export interface PiMessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  responseId?: string;
}

export interface PiToolDefinitionLike {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

/**
 * Pi 1.x hands providers a transcript whose `system` messages carry the prompt
 * and tool set; OMP keeps them on `systemPrompt` (string or string[]) and
 * `tools`. Both shapes are accepted.
 */
export interface PiContextLike {
  systemPrompt?: string | readonly string[];
  messages: readonly PiMessageLike[];
  tools?: readonly PiToolDefinitionLike[];
}

function userContent(content: unknown): BridgeUserContent[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: BridgeUserContent[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if (block?.type === "image" && typeof block.data === "string") {
      out.push({ type: "image", data: block.data, mimeType: String(block.mimeType ?? "image/png") });
    }
  }
  return out;
}

const STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value || "{}") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      // A stored call whose arguments no longer parse still pairs with its
      // result; sending empty arguments keeps that pairing intact.
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Flatten Pi / OMP messages into the neutral shape.
 *
 * - `system` messages are dropped here — their text and tool deltas are read
 *   by {@link toBridgeContext}.
 * - OMP `developer` messages are host-injected instructions with no vendor
 *   slot; they travel as user turns rather than being lost.
 * - Block kinds no vendor has a slot for (redacted thinking, server-tool
 *   blocks) are dropped rather than flattened into text the model would read
 *   back as its own speech.
 */
export function toBridgeMessages(messages: readonly PiMessageLike[]): BridgeMessage[] {
  const out: BridgeMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" || message.role === "developer") {
      out.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        role: "toolResult",
        toolCallId: String(message.toolCallId ?? ""),
        toolName: String(message.toolName ?? "tool"),
        content: userContent(message.content),
        isError: message.isError === true,
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const content: BridgeAssistantContent[] = [];
    for (const block of (Array.isArray(message.content) ? message.content : []) as Array<Record<string, unknown>>) {
      if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
      else if (block?.type === "thinking" && typeof block.thinking === "string") {
        content.push({
          type: "thinking",
          thinking: block.thinking,
          ...(typeof block.thinkingSignature === "string" && block.thinkingSignature
            ? { thinkingSignature: block.thinkingSignature }
            : {}),
        });
      } else if (block?.type === "toolCall") {
        content.push({
          type: "toolCall",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: parseArguments(block.arguments),
        });
      }
    }
    out.push({
      role: "assistant",
      content,
      ...(message.stopReason && STOP_REASONS.has(message.stopReason)
        ? { stopReason: message.stopReason as BridgeStopReason }
        : {}),
      ...(typeof message.responseId === "string" && message.responseId ? { responseId: message.responseId } : {}),
    });
  }
  return out;
}

export function toBridgeTools(tools: readonly PiToolDefinitionLike[] | undefined): BridgeTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  }));
}

/** The system prompt a Pi or OMP context resolves to, or undefined when it has none. */
export function resolveSystemPrompt(context: PiContextLike): string | undefined {
  const parts: string[] = [];
  const declared = context.systemPrompt;
  if (typeof declared === "string") parts.push(declared);
  else if (Array.isArray(declared)) parts.push(...declared.filter((part): part is string => typeof part === "string"));
  const fromTranscript = getCurrentSystemPrompt(context.messages);
  if (fromTranscript) parts.push(fromTranscript);
  const joined = parts.filter((part) => part.trim().length > 0).join("\n\n");
  return joined || undefined;
}

/** The tool set a Pi or OMP context resolves to: explicit `tools` first, then the transcript's. */
export function resolveTools(context: PiContextLike): PiToolDefinitionLike[] {
  if (context.tools?.length) return [...context.tools];
  return getCurrentTools<PiToolDefinitionLike>(context.messages);
}

/** Project a whole Pi / OMP request context onto the neutral one. */
export function toBridgeContext(context: PiContextLike): BridgeContext {
  const systemPrompt = resolveSystemPrompt(context);
  const tools = toBridgeTools(resolveTools(context));
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: toBridgeMessages(context.messages),
    ...(tools ? { tools } : {}),
  };
}

// ABOUTME: Projects the Anthropic Messages request (what ZCode sends) onto the neutral one every vendor core reads.
// ABOUTME: One direction only — responses travel back as stream events or an assembled message.

import { toBridgeEffort } from "../effort.js";
import type {
  BridgeAssistantContent,
  BridgeContext,
  BridgeEffort,
  BridgeMessage,
  BridgeTool,
  BridgeToolResultMessage,
  BridgeUserContent,
} from "../types.js";

/** System-prompt text as a request field; blocks may carry cache_control, which the bridge ignores. */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicBase64ImageSource {
  type: "base64";
  media_type: string;
  data: string;
}

export interface AnthropicUrlImageSource {
  type: "url";
  url: string;
}

export type AnthropicImageSource = AnthropicBase64ImageSource | AnthropicUrlImageSource;

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** Encrypted reasoning the client replays verbatim; the neutral vocabulary has no slot for it. */
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Server tools carry a dated type (`web_search_20250305`); custom tools say `custom` or omit it. */
export interface AnthropicToolDefinition {
  type?: string;
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicThinkingConfig {
  type: "enabled" | "adaptive" | "disabled";
  budget_tokens?: number;
}

export interface AnthropicOutputConfig {
  effort?: string;
}

/**
 * The subset of the Anthropic Messages request this bridge reads. Fields the
 * neutral vocabulary has no slot for (temperature, metadata, tool_choice, ...)
 * may be present and are ignored.
 */
export interface AnthropicRequestBody {
  model: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  metadata?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

/** The neutral request a vendor core reads, with the routing fields the server needs alongside it. */
export interface BridgeRequestFromAnthropic {
  model: string;
  maxTokens?: number;
  stream: boolean;
  context: BridgeContext;
  effort?: BridgeEffort;
}

export type AnthropicRequestResult = BridgeRequestFromAnthropic | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL image has no bytes to carry, so the model reads a placeholder naming it instead. */
function pushImage(out: BridgeUserContent[], source: unknown): void {
  if (!isRecord(source)) return;
  if (source.type === "base64") {
    if (typeof source.media_type === "string" && typeof source.data === "string") {
      out.push({ type: "image", data: source.data, mimeType: source.media_type });
    }
  } else if (source.type === "url" && typeof source.url === "string") {
    out.push({ type: "text", text: `[image: ${source.url}]` });
  }
}

/** Text and image blocks, shared by user turns and tool-result contents. */
function userContent(content: unknown): BridgeUserContent[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: BridgeUserContent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string") out.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      pushImage(out, block.source);
    }
  }
  return out;
}

function systemPrompt(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const joined = parts.join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

function appendUserMessage(out: BridgeMessage[], content: unknown, toolNames: ReadonlyMap<string, string>): void {
  if (typeof content === "string") {
    if (content.length > 0) out.push({ role: "user", content: [{ type: "text", text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;
  const plain: BridgeUserContent[] = [];
  const results: BridgeToolResultMessage[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      results.push({
        role: "toolResult",
        toolCallId: id,
        toolName: toolNames.get(id) ?? "",
        content: userContent(block.content),
        isError: block.is_error === true,
      });
    } else if (block.type === "text") {
      if (typeof block.text === "string") plain.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      pushImage(plain, block.source);
    }
  }
  // Tool results lead the turn they arrived in, and the rest of the message
  // follows as one user turn — a message of results alone has no user turn left.
  for (const result of results) out.push(result);
  if (plain.length > 0) out.push({ role: "user", content: plain });
}

function appendAssistantMessage(out: BridgeMessage[], content: unknown, toolNames: Map<string, string>): void {
  const blocks: BridgeAssistantContent[] = [];
  if (typeof content === "string") {
    if (content.length > 0) blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text") {
        if (typeof block.text === "string") blocks.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        if (typeof block.thinking === "string") {
          blocks.push({
            type: "thinking",
            thinking: block.thinking,
            ...(typeof block.signature === "string" && block.signature.length > 0
              ? { thinkingSignature: block.signature }
              : {}),
          });
        }
      } else if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        // The result arrives in a later user turn, which only knows the call's
        // id; remember the name for it.
        toolNames.set(id, name);
        blocks.push({ type: "toolCall", id, name, arguments: isRecord(block.input) ? block.input : {} });
      }
      // `redacted_thinking` has no neutral slot; dropping it keeps the model
      // from reading encrypted blobs back as its own speech.
    }
  }
  if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
}

/**
 * Server tools carry a dated `type` and no input_schema; without a schema there
 * is nothing to project, so they are skipped here with everything else unmappable.
 */
function toBridgeTools(value: unknown): BridgeTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BridgeTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const schema = entry.input_schema;
    if (typeof entry.name !== "string" || !isRecord(schema)) continue;
    out.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      parameters: schema,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The host's explicit effort wins; a thinking budget stands in for one, and
 * `adaptive` asks for the vendor's most intensive default.
 */
function resolveEffort(body: Record<string, unknown>): BridgeEffort | undefined {
  const outputConfig = body.output_config;
  if (isRecord(outputConfig)) {
    const declared = toBridgeEffort(outputConfig.effort);
    if (declared) return declared;
  }
  const thinking = body.thinking;
  if (!isRecord(thinking)) return undefined;
  if (thinking.type === "adaptive") return "high";
  if (thinking.type !== "enabled" || typeof thinking.budget_tokens !== "number") return undefined;
  if (thinking.budget_tokens < 4096) return "low";
  if (thinking.budget_tokens < 16384) return "medium";
  return "high";
}

/**
 * Validate an Anthropic Messages request body and project it onto the neutral
 * shape. Returns `{ error }` with a client-facing message instead of throwing,
 * so the server can answer 400 without a try/catch.
 */
export function toBridgeRequest(body: unknown): AnthropicRequestResult {
  if (!isRecord(body)) return { error: "request body must be a JSON object" };
  if (typeof body.model !== "string" || body.model.length === 0) return { error: "model is required" };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: "messages must be a non-empty array" };
  }

  const messages: BridgeMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of body.messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === "user") appendUserMessage(messages, raw.content, toolNames);
    else if (raw.role === "assistant") appendAssistantMessage(messages, raw.content, toolNames);
  }

  const system = systemPrompt(body.system);
  const tools = toBridgeTools(body.tools);
  const effort = resolveEffort(body);
  return {
    model: body.model,
    ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
    stream: body.stream === true,
    context: {
      ...(system ? { systemPrompt: system } : {}),
      messages,
      ...(tools ? { tools } : {}),
    },
    ...(effort ? { effort } : {}),
  };
}

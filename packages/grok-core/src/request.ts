// ABOUTME: Builds one OpenAI Responses request from the host transcript.
// ABOUTME: The host is the harness, so thinking is not replayed and no Grok tool is added.

import { GROK_DEFAULT_CONTEXT_WINDOW } from "./catalog.js";
import type { GrokEffort, GrokMessage, GrokTool, GrokUserContent } from "./types.js";

function userParts(content: readonly GrokUserContent[]): unknown[] {
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "input_text", text: part.text });
    } else if (part.data) {
      parts.push({ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
    }
  }
  return parts;
}

function outputText(content: readonly GrokUserContent[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `data:${part.mimeType};base64,${part.data}`))
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Responses `input` items. Assistant thinking is omitted: the summary is not replayable content. */
export function toResponsesInput(messages: readonly GrokMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = userParts(message.content);
      if (content.length > 0) items.push({ type: "message", role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.arguments ?? {}),
        });
      }
      continue;
    }
    if (!message.toolCallId) continue;
    items.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: outputText(message.content),
    });
  }
  return items;
}

function toolItem(tool: GrokTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
  };
}

/**
 * Rough token count of one Responses body.
 *
 * Grok's tokenizer is not available here, and the proxy rejects a prompt only
 * after it has counted the real tokens. Four characters per token undercounts
 * code and base64, which is the direction that keeps a near-limit prompt from
 * being sent: a short prompt is never touched, and a prompt this estimate
 * already puts over the window is one the proxy would refuse.
 */
export function estimateResponsesTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}

/**
 * Drop the oldest input items until the body fits the model's window.
 *
 * The newest items are the current turn, so they stay. A `function_call` is
 * kept together with the `function_call_output` that answers it: sending one
 * without the other is a request the proxy rejects for a different reason.
 * When one item is larger than the window on its own, the body is returned
 * unchanged and the proxy's refusal is what the host compacts on.
 */
export function fitResponsesBody(
  body: Record<string, unknown>,
  contextWindow = GROK_DEFAULT_CONTEXT_WINDOW,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || estimateResponsesTokens(body) <= contextWindow) return body;

  const kept = input.slice();
  while (kept.length > 1 && estimateResponsesTokens({ ...body, input: kept }) > contextWindow) {
    const dropped = kept[0] as { type?: unknown };
    kept.shift();
    if (
      dropped?.type === "function_call" &&
      (kept[0] as { type?: unknown } | undefined)?.type === "function_call_output"
    ) {
      kept.shift();
    }
  }
  return { ...body, input: kept };
}

export function buildResponsesBody(input: {
  model: string;
  systemPrompt?: string;
  messages: readonly GrokMessage[];
  tools?: readonly GrokTool[];
  effort?: GrokEffort;
  /** Model context window. Items that would push the body past it are dropped. */
  contextWindow?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: toResponsesInput(input.messages),
    stream: true,
  };
  const instructions = input.systemPrompt?.trim();
  if (instructions) body.instructions = instructions;
  if (input.tools && input.tools.length > 0) body.tools = input.tools.map(toolItem);
  if (input.effort) body.reasoning = { effort: input.effort, summary: "auto" };
  return fitResponsesBody(body, input.contextWindow);
}

// ABOUTME: Builds one OpenAI Responses request from the host transcript.
// ABOUTME: The host is the harness, so thinking is not replayed and no Grok tool is added.

import type { BridgeEffort, BridgeMessage, BridgeTool, BridgeUserContent } from "ns-bridge-core";

/** Catalog ids ending in `-agent` are a host alias. The proxy wants the base id. */
export function grokWireModelId(modelId: string): string {
  return modelId.endsWith("-agent") ? modelId.slice(0, -"-agent".length) : modelId;
}

function userParts(content: readonly BridgeUserContent[]): unknown[] {
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

function outputText(content: readonly BridgeUserContent[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `data:${part.mimeType};base64,${part.data}`))
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Responses `input` items. Assistant thinking is omitted: the summary is not replayable content. */
export function toResponsesInput(messages: readonly BridgeMessage[]): unknown[] {
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

function toolItem(tool: BridgeTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
  };
}

export function buildResponsesBody(input: {
  model: string;
  systemPrompt?: string;
  messages: readonly BridgeMessage[];
  tools?: readonly BridgeTool[];
  effort?: BridgeEffort;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: grokWireModelId(input.model),
    input: toResponsesInput(input.messages),
    stream: true,
  };
  const instructions = input.systemPrompt?.trim();
  if (instructions) body.instructions = instructions;
  if (input.tools && input.tools.length > 0) body.tools = input.tools.map(toolItem);
  if (input.effort) body.reasoning = { effort: input.effort, summary: "auto" };
  return body;
}

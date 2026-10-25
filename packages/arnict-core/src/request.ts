// ABOUTME: Builds one OpenAI chat-completions request from the host transcript.
// ABOUTME: No reasoning/effort params: arnict.com/docs documents neither, so none are sent.

import type { ArnictMessage, ArnictTool, ArnictUserContent } from "./types.js";

function textOf(content: readonly ArnictUserContent[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function userContent(content: readonly ArnictUserContent[]): string | unknown[] {
  const hasImages = content.some((part) => part.type === "image");
  if (!hasImages) return textOf(content);
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "text", text: part.text });
    } else if (part.data) {
      parts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
    }
  }
  return parts;
}

function resultText(content: readonly ArnictUserContent[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : "[image omitted]"))
    .filter((text) => text.length > 0)
    .join("\n");
}

function chatMessages(input: { systemPrompt?: string; messages: readonly ArnictMessage[] }): unknown[] {
  const messages: unknown[] = [];
  const system = input.systemPrompt?.trim();
  if (system) messages.push({ role: "system", content: system });
  for (const message of input.messages) {
    if (message.role === "user") {
      const content = userContent(message.content);
      if (content.length > 0) {
        messages.push({ role: "user", content });
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
        }));
      if (!text && toolCalls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    messages.push({ role: "tool", tool_call_id: message.toolCallId, content: resultText(message.content) });
  }
  return messages;
}

export function buildChatCompletionsBody(input: {
  model: string;
  systemPrompt?: string;
  messages: readonly ArnictMessage[];
  tools?: readonly ArnictTool[];
  maxTokens?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: chatMessages(input),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return body;
}

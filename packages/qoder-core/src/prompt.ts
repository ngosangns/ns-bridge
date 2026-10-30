// ABOUTME: Serializes the host transcript into OpenAI-style wire messages for
// the Qoder model server (shapes mirror a captured qodercli request).

import type { QoderMessage } from "./types.js";

export interface QoderWireTextPart {
  type: "text";
  text: string;
}

export interface QoderWireImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type QoderWireContentPart = QoderWireTextPart | QoderWireImagePart;

export interface QoderWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface QoderWireSystemMessage {
  role: "system";
  content: QoderWireContentPart[];
}
export interface QoderWireUserMessage {
  role: "user";
  content: string | QoderWireContentPart[];
}
export interface QoderWireAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: QoderWireToolCall[];
}
export interface QoderWireToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type QoderWireMessage =
  | QoderWireSystemMessage
  | QoderWireUserMessage
  | QoderWireAssistantMessage
  | QoderWireToolMessage;

function imageDataUrl(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType || "image/png"};base64,${data}`;
}

function userContent(content: readonly { type: string; text?: string; data?: string; mimeType?: string }[]): {
  text: string;
  parts: QoderWireContentPart[];
} {
  const parts: QoderWireContentPart[] = [];
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      texts.push(part.text);
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image" && part.data) {
      parts.push({
        type: "image_url",
        image_url: { url: imageDataUrl(part.data, part.mimeType || "image/png") },
      });
    }
  }
  return { text: texts.join("\n"), parts };
}

function toWireMessage(message: QoderMessage): QoderWireMessage | undefined {
  if (message.role === "user") {
    const { text, parts } = userContent(message.content);
    if (!text && parts.length === 0) return undefined;
    return { role: "user", content: parts.some((part) => part.type === "image_url") ? parts : text };
  }
  if (message.role === "toolResult") {
    const { text, parts } = userContent(message.content);
    const note = parts
      .filter((part) => part.type === "image_url")
      .map(() => "[image attached]")
      .join("\n");
    const body = [text, note].filter(Boolean).join("\n");
    if (!body) return undefined;
    return { role: "tool", tool_call_id: message.toolCallId, content: body };
  }
  const { text } = userContent(message.content);
  const toolCalls = message.content.flatMap((part) =>
    part.type === "toolCall"
      ? [
          {
            id: part.id,
            type: "function" as const,
            function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
          },
        ]
      : [],
  );
  if (!text && toolCalls.length === 0) return undefined;
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/** Full transcript as wire messages. Stateless: the host resends it every turn. */
export function toQoderWireMessages(messages: readonly QoderMessage[], systemPrompt?: string): QoderWireMessage[] {
  const wire: QoderWireMessage[] = [];
  const system = systemPrompt?.trim();
  if (system) wire.push({ role: "system", content: [{ type: "text", text: system }] });
  for (const message of messages) {
    const wireMessage = toWireMessage(message);
    if (wireMessage) wire.push(wireMessage);
  }
  return wire;
}

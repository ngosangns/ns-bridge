// ABOUTME: Serializes the host transcript into one Qoder user prompt per turn.

import type { QoderMessage, QoderUserContent } from "./types.js";

export interface QoderPromptImage {
  mimeType: string;
  data: string;
}

function serializeUser(content: readonly QoderUserContent[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) parts.push(part.text);
    if (part.type === "image") parts.push("[image attached]");
  }
  return parts.join("\n");
}

function serializeMessage(message: QoderMessage): string {
  if (message.role === "user") {
    return `User:\n${serializeUser(message.content)}`;
  }
  if (message.role === "toolResult") {
    const body = serializeUser(message.content);
    const prefix = message.isError ? "Tool error" : "Tool result";
    return `${prefix} (${message.toolName}, id=${message.toolCallId}):\n${body}`;
  }
  const lines: string[] = ["Assistant:"];
  for (const part of message.content) {
    if (part.type === "text" && part.text) lines.push(part.text);
    if (part.type === "thinking" && part.thinking) lines.push(`[thinking]\n${part.thinking}`);
    if (part.type === "toolCall") {
      lines.push(`[tool_call ${part.name} id=${part.id}]\n${JSON.stringify(part.arguments)}`);
    }
  }
  return lines.join("\n");
}

/**
 * One string prompt for `query({ prompt })`. The host sends the full transcript
 * on every turn, so each call is stateless on the Qoder side.
 * Image bytes are not inlined here. `collectQoderImages` returns them for the SDK.
 */
export function buildQoderPrompt(messages: readonly QoderMessage[], systemPrompt?: string): string {
  const blocks: string[] = [];
  if (systemPrompt?.trim()) {
    blocks.push(`<system>\n${systemPrompt.trim()}\n</system>`);
  }
  for (const message of messages) {
    const body = serializeMessage(message);
    if (body.trim()) blocks.push(body);
  }
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (lastUser && messages[messages.length - 1]?.role !== "user") {
    blocks.push("User:\n(continue)");
  }
  return blocks.join("\n\n");
}

/** Image parts from the transcript, in order. The stream attaches these as SDK image blocks. */
export function collectQoderImages(messages: readonly QoderMessage[]): QoderPromptImage[] {
  const images: QoderPromptImage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "image" || !part.data) continue;
      images.push({ mimeType: part.mimeType || "image/png", data: part.data });
    }
  }
  return images;
}

/** Strip a data-URL prefix so the SDK receives raw base64. */
export function qoderImageData(data: string): string {
  const marker = "base64,";
  const index = data.indexOf(marker);
  if (data.startsWith("data:") && index !== -1) return data.slice(index + marker.length);
  return data;
}

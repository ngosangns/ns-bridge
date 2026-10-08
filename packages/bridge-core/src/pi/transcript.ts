// ABOUTME: Pi 1.x transcript helpers: the system prompt and tool set live in `system` messages.
// ABOUTME: Mirrors @earendil-works/pi-ai `utils/transcript`; OMP has no such messages, so these are no-ops there.

export interface PiToolLike {
  name: string;
  [key: string]: unknown;
}

interface PiSystemMessageLike {
  role: string;
  content?: unknown;
  toolsAdded?: PiToolLike[];
  toolsRemoved?: Array<{ name: string }>;
  sections?: Record<string, string | null>;
}

function isSystemMessage(message: { role: string } | undefined): message is PiSystemMessageLike {
  return message?.role === "system";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
export function withoutInitialSystemMessage<T extends { role: string }>(messages: T[]): T[] {
  return messages.length > 0 && isSystemMessage(messages[0]) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools<T = PiToolLike>(messages: ReadonlyArray<{ role: string }>): T[] {
  const tools = new Map<string, PiToolLike>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()] as T[];
}

/**
 * Render the current system prompt after replaying every system message:
 * base `content` blocks are concatenated, named `sections` are patched in
 * order (null deletes) and appended after the base prompt.
 */
export function getCurrentSystemPrompt(messages: ReadonlyArray<{ role: string }>): string {
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [content.join("\n\n"), ...sections.values()].filter((part) => part.length > 0).join("\n\n");
}

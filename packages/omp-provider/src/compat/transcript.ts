/**
 * Pi 1.0 transcript helpers that OMP's pi-ai does not ship.
 *
 * Pi 1.0 folds the system prompt and tool set into `role: "system"` messages
 * (`toolsAdded` / `toolsRemoved` deltas) and providers read them back with
 * these helpers. OMP keeps them on `context.systemPrompt` / `context.tools`
 * and never puts system messages in the transcript, so on OMP these resolve
 * to "" / [] / the messages unchanged — and the providers fall through to
 * the (normalized) `context.systemPrompt` / `context.tools` they check first.
 *
 * Semantics mirror @earendil-works/pi-ai 1.0 `dist/utils/transcript.js`.
 */

export interface ToolLike {
  name: string;
  [key: string]: unknown;
}

export interface MessageLike {
  role: string;
  content?: unknown;
  toolsAdded?: ToolLike[];
  toolsRemoved?: Array<{ name: string }>;
  sections?: Record<string, string | null>;
  timestamp?: number;
  [key: string]: unknown;
}

function isSystemMessage(message: MessageLike | undefined): boolean {
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
  return messages.length > 0 && isSystemMessage(messages[0] as MessageLike) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools<T = ToolLike>(messages: ReadonlyArray<{ role: string }>): T[] {
  const tools = new Map<string, ToolLike>();
  for (const message of messages as MessageLike[]) {
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
  for (const message of messages as MessageLike[]) {
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

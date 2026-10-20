/**
 * ACP content handed to `grok --prompt-file`. Images travel beside the transcript text.
 *
 * Grok 1.0.62 writes `prompts/prompt_N.txt` and tells the model to `read_file`
 * the omitted lines once `<user_query>` passes 100_000 bytes. A 99_599-byte
 * query stayed inline; the next one, 101_047 bytes, was offloaded. This adapter
 * sends the whole harness transcript as that one message, so each read comes
 * back on the next turn and the following prompt is larger.
 *
 * Keeping every tool result at a 400-byte floor still sums past that line, and
 * it also cuts the newest file contents, so the model reads the same files again.
 * Drop the oldest messages instead, leave the newest turns whole, and trim a
 * tool result only when that result alone still does not fit. That budget is
 * the cold start. Later steps resume the same Grok session and send only the
 * new tool results, which is how Pi and OMP stay small. A read of the offloaded
 * prompt file is not replayed. Reasoning stays on the host's thinking card and
 * is not copied into this prompt.
 */

/**
 * Byte budget for the `<user_query>` Grok wraps around the ACP text.
 * 96_000 sits under the 99_599-byte query that still stayed inline.
 */
export const GROK_INLINE_USER_QUERY_BYTES = 96_000;

const TOOL_FLOOR_BYTES = 400;

const OMITTED_TURNS = "Earlier turns were omitted so this request stays within the model context limit.";

const PROMPT_FILE_READ = /[/\\]\.grok[/\\]sessions[/\\][^\s"'<>]*[/\\]prompts[/\\]prompt_\d+\.txt/;

const PROMPT_FILE_OMISSION =
  "Omitted. This result was a read of the Grok prompt file prompts/prompt_N.txt, which is this same transcript. Do not read that file.";

interface PromptBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: string;
  /** Base64 image bytes. Present only when this block is sent as an image. */
  data?: string;
  mimeType?: string;
  /** Text used when the image bytes are not sent. */
  placeholder?: string;
}

export interface GrokPromptInput {
  system?: string;
  messages: readonly {
    role?: string;
    content?: readonly PromptBlock[];
  }[];
}

export type GrokAcpBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string };

const ROLE_LABEL: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  developer: "Developer",
};

/** Bytes of the `<user_query>` Grok wraps around these text blocks. */
export function grokUserQueryByteLength(blocks: readonly GrokAcpBlock[]): number {
  const body = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return Buffer.byteLength(`<user_query>\n${body}\n</user_query>`, "utf8");
}

/** One ACP `content` array. An empty transcript is a single space so the CLI accepts the file. */
export function buildGrokAcpContent(input: GrokPromptInput): GrokAcpBlock[] {
  return assembleAcp(fitGrokInlinePrompt(input));
}

/** Identity of the harness transcript already stored in a Grok session. */
export interface GrokPromptMemory {
  readonly count: number;
  readonly fingerprint: string;
}

/** `full` starts a Grok session. `delta` is the tail resumed into that session. */
export interface GrokPromptPlan {
  readonly mode: "full" | "delta";
  readonly input: GrokPromptInput;
  readonly count: number;
  readonly fingerprint: string;
}

/** Stable id of the transcript. A rewritten prefix, including compaction, does not match. */
export function grokPromptFingerprint(input: GrokPromptInput): string {
  const system = Buffer.byteLength(input.system ?? "", "utf8");
  return `${system}|${input.messages.map(messageStamp).join("\n")}`;
}

/**
 * The first call sends the transcript. A later call whose prefix is unchanged
 * sends only the messages appended after it, skipping the assistant reply Grok
 * already stored. A changed prefix starts over.
 */
export function planGrokPrompt(input: GrokPromptInput, memory?: GrokPromptMemory): GrokPromptPlan {
  const fingerprint = grokPromptFingerprint(input);
  const count = input.messages.length;
  if (memory && memory.count > 0 && memory.count <= count) {
    const prefix: GrokPromptInput = { system: input.system, messages: input.messages.slice(0, memory.count) };
    if (grokPromptFingerprint(prefix) === memory.fingerprint) {
      let tail = input.messages.slice(memory.count);
      if (tail[0]?.role === "assistant") tail = tail.slice(1);
      return { mode: "delta", input: { messages: tail }, count, fingerprint };
    }
  }
  return { mode: "full", input, count, fingerprint };
}

function messageStamp(message: GrokPromptInput["messages"][number]): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.text) parts.push(block.text);
    else if (block.name) parts.push(`${block.name} ${block.arguments ?? ""}`);
    else if (block.placeholder) parts.push(block.placeholder);
  }
  const text = parts.join("\n");
  return `${message.role ?? ""}:${Buffer.byteLength(text, "utf8")}:${text.slice(0, 48)}`;
}

function assembleAcp(input: GrokPromptInput): GrokAcpBlock[] {
  const blocks: GrokAcpBlock[] = [];
  if (input.system?.trim()) blocks.push({ type: "text", text: input.system.trim() });
  for (const message of input.messages) {
    const lines: string[] = [];
    const images: GrokAcpBlock[] = [];
    for (const block of message.content ?? []) {
      // The host already shows this on its native thinking card.
      if (block.type === "reasoning") continue;
      if (block.type === "text" && block.text) {
        lines.push(block.text);
      } else if (block.type === "tool-call") {
        const name = block.name ?? "tool";
        lines.push(block.arguments ? `${name} ${block.arguments}` : name);
      } else if (block.type === "image") {
        if (block.data && block.mimeType) images.push({ type: "image", mimeType: block.mimeType, data: block.data });
        else if (block.placeholder) lines.push(block.placeholder);
      }
    }
    if (lines.length === 0 && images.length === 0) continue;
    const label = ROLE_LABEL[message.role ?? ""] ?? message.role ?? "Message";
    blocks.push({ type: "text", text: lines.length > 0 ? `${label}:\n${lines.join("\n")}` : `${label}:` });
    blocks.push(...images);
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: " " });
  return blocks;
}

function fitGrokInlinePrompt(input: GrokPromptInput): GrokPromptInput {
  let messages = input.messages.map(omitPromptFileRead);
  const anchor = messages.find((message) => message.role === "user");
  let omittedTurns = false;

  for (let pass = 0; pass < input.messages.length + 8; pass++) {
    const candidate = omittedTurns ? withOmittedTurnsNote(messages, anchor) : messages;
    const size = grokUserQueryByteLength(assembleAcp({ ...input, messages: candidate }));
    if (size <= GROK_INLINE_USER_QUERY_BYTES) return { ...input, messages: candidate };

    const nonAnchor = messages.flatMap((message, index) => (message !== anchor ? [index] : []));
    const soleTool = nonAnchor.length === 1 ? messages[nonAnchor[0]] : undefined;
    if (soleTool?.role === "tool" && toolBytes(soleTool) > TOOL_FLOOR_BYTES) {
      const index = nonAnchor[0] ?? 0;
      messages = messages.map((message, i) =>
        i === index ? shrinkTool(message, size - GROK_INLINE_USER_QUERY_BYTES) : message,
      );
      continue;
    }
    const index = nonAnchor[0];
    if (index === undefined) return { ...input, messages: candidate };
    messages = messages.filter((_, i) => i !== index);
    omittedTurns = true;
  }

  const candidate = omittedTurns ? withOmittedTurnsNote(messages, anchor) : messages;
  return { ...input, messages: candidate };
}

function withOmittedTurnsNote(
  messages: GrokPromptInput["messages"],
  anchor: GrokPromptInput["messages"][number] | undefined,
): GrokPromptInput["messages"] {
  const note = { role: "user", content: [{ type: "text", text: OMITTED_TURNS }] };
  if (!anchor) return [note, ...messages];
  const index = messages.indexOf(anchor);
  if (index < 0) return [note, ...messages];
  return [...messages.slice(0, index + 1), note, ...messages.slice(index + 1)];
}

function omitPromptFileRead(message: GrokPromptInput["messages"][number]): GrokPromptInput["messages"][number] {
  if (message.role !== "tool" || !PROMPT_FILE_READ.test(toolPlain(message))) return message;
  return withToolText(message, PROMPT_FILE_OMISSION);
}

function shrinkTool(
  message: GrokPromptInput["messages"][number],
  overflow: number,
): GrokPromptInput["messages"][number] {
  const text = toolPlain(message);
  const textBytes = Buffer.byteLength(text, "utf8");
  const target = Math.max(TOOL_FLOOR_BYTES, textBytes - overflow - 64);
  return withToolText(message, trimText(text, target));
}

function toolPlain(message: GrokPromptInput["messages"][number]): string {
  return (message.content ?? [])
    .filter((block) => (block.type === "text" || block.type === "reasoning") && block.text)
    .map((block) => block.text ?? "")
    .join("\n");
}

function toolBytes(message: GrokPromptInput["messages"][number]): number {
  return Buffer.byteLength(toolPlain(message), "utf8");
}

function withToolText(message: GrokPromptInput["messages"][number], text: string): GrokPromptInput["messages"][number] {
  const rest = (message.content ?? []).filter((block) => block.type !== "text" && block.type !== "reasoning");
  return { ...message, content: [{ type: "text", text }, ...rest] };
}

function trimText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const note = "\n…[older tool output omitted so this prompt stays inline]…\n";
  const room = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
  const headBytes = Math.floor(room / 2);
  return `${takeBytes(text, headBytes, false)}${note}${takeBytes(text, room - headBytes, true)}`;
}

function takeBytes(text: string, maxBytes: number, fromEnd: boolean): string {
  if (maxBytes <= 0) return "";
  const chars = [...text];
  const order = fromEnd ? [...chars].reverse() : chars;
  let used = 0;
  const kept: string[] = [];
  for (const char of order) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    kept.push(char);
    used += size;
  }
  if (fromEnd) kept.reverse();
  return kept.join("");
}

export function grokAcpDocument(content: readonly GrokAcpBlock[]): string {
  return JSON.stringify({ type: "acp", content });
}

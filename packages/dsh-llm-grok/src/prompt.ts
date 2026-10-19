/** ACP content handed to `grok --prompt-file`. Images travel beside the transcript text. */

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

/** One ACP `content` array. An empty transcript is a single space so the CLI accepts the file. */
export function buildGrokAcpContent(input: GrokPromptInput): GrokAcpBlock[] {
  const blocks: GrokAcpBlock[] = [];
  if (input.system?.trim()) blocks.push({ type: "text", text: input.system.trim() });
  for (const message of input.messages) {
    const lines: string[] = [];
    const images: GrokAcpBlock[] = [];
    for (const block of message.content ?? []) {
      if ((block.type === "text" || block.type === "reasoning") && block.text) {
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

export function grokAcpDocument(content: readonly GrokAcpBlock[]): string {
  return JSON.stringify({ type: "acp", content });
}

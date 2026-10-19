/** Plain-text transcript handed to `grok --single`. */

interface PromptBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: string;
}

export interface GrokPromptInput {
  system?: string;
  messages: readonly {
    role?: string;
    content?: readonly PromptBlock[];
  }[];
}

const ROLE_LABEL: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  developer: "Developer",
};

export function buildGrokPrompt(input: GrokPromptInput): string {
  const parts: string[] = [];
  if (input.system?.trim()) parts.push(input.system.trim());
  for (const message of input.messages) {
    const lines: string[] = [];
    for (const block of message.content ?? []) {
      if ((block.type === "text" || block.type === "reasoning") && block.text) {
        lines.push(block.text);
      } else if (block.type === "tool-call") {
        const name = block.name ?? "tool";
        lines.push(block.arguments ? `${name} ${block.arguments}` : name);
      }
    }
    if (lines.length === 0) continue;
    const label = ROLE_LABEL[message.role ?? ""] ?? message.role ?? "Message";
    parts.push(`${label}:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

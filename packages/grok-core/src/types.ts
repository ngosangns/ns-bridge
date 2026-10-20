/**
 * The neutral vocabulary this core speaks. It matches ns-bridge-core by shape,
 * checked in test/vocabulary.test.ts, so this package does not import the bridge.
 */

export type GrokEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GrokTextContent {
  type: "text";
  text: string;
}
export interface GrokImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface GrokThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface GrokToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type GrokUserContent = GrokTextContent | GrokImageContent;
export type GrokAssistantContent = GrokTextContent | GrokThinkingContent | GrokToolCallContent;

export type GrokStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface GrokUserMessage {
  role: "user";
  content: GrokUserContent[];
}
export interface GrokAssistantMessage {
  role: "assistant";
  content: GrokAssistantContent[];
  stopReason?: GrokStopReason;
  responseId?: string;
}
export interface GrokToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: GrokUserContent[];
  isError: boolean;
}

export type GrokMessage = GrokUserMessage | GrokAssistantMessage | GrokToolResultMessage;

export interface GrokTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface GrokCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface GrokUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextPercent?: number;
  credits?: number;
  creditUnit?: string;
  cacheEstimated?: boolean;
  cost: GrokCost;
}

export type GrokStreamEvent =
  | { type: "start" }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "text_end"; index: number; text: string }
  | { type: "thinking_start"; index: number }
  | { type: "thinking_delta"; index: number; delta: string }
  | { type: "thinking_end"; index: number; thinking: string; signature?: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; id: string; argumentsDelta: string }
  | {
      type: "tool_call_end";
      index: number;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      argumentsJson?: string;
    }
  | { type: "reset" }
  | { type: "usage"; usage: GrokUsage }
  | {
      type: "done";
      stopReason: "stop" | "toolUse" | "length";
      errorMessage?: string;
      responseId?: string;
      upstreamModel?: string;
    };

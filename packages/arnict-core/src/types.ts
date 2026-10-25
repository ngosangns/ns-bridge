/**
 * The neutral vocabulary this core speaks. It matches ns-bridge-core by shape,
 * checked in test/vocabulary.test.ts, so this package does not import the bridge.
 */

export type ArnictEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ArnictTextContent {
  type: "text";
  text: string;
}
export interface ArnictImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ArnictThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface ArnictToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ArnictUserContent = ArnictTextContent | ArnictImageContent;
export type ArnictAssistantContent = ArnictTextContent | ArnictThinkingContent | ArnictToolCallContent;

export type ArnictStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface ArnictUserMessage {
  role: "user";
  content: ArnictUserContent[];
}
export interface ArnictAssistantMessage {
  role: "assistant";
  content: ArnictAssistantContent[];
  stopReason?: ArnictStopReason;
  responseId?: string;
}
export interface ArnictToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ArnictUserContent[];
  isError: boolean;
}

export type ArnictMessage = ArnictUserMessage | ArnictAssistantMessage | ArnictToolResultMessage;

export interface ArnictTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ArnictCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ArnictUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextPercent?: number;
  credits?: number;
  creditUnit?: string;
  cacheEstimated?: boolean;
  cost: ArnictCost;
}

export type ArnictStreamEvent =
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
  | { type: "usage"; usage: ArnictUsage }
  | {
      type: "done";
      stopReason: "stop" | "toolUse" | "length";
      errorMessage?: string;
      responseId?: string;
      upstreamModel?: string;
    };

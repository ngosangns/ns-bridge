/**
 * Neutral vocabulary for the Qoder core. Matches ns-bridge-core by shape
 * (see test/vocabulary.test.ts); this package does not import the bridge.
 */

export type QoderEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface QoderTextContent {
  type: "text";
  text: string;
}
export interface QoderImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface QoderThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface QoderToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type QoderUserContent = QoderTextContent | QoderImageContent;
export type QoderAssistantContent = QoderTextContent | QoderThinkingContent | QoderToolCallContent;

export type QoderStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface QoderUserMessage {
  role: "user";
  content: QoderUserContent[];
}
export interface QoderAssistantMessage {
  role: "assistant";
  content: QoderAssistantContent[];
  stopReason?: QoderStopReason;
  responseId?: string;
}
export interface QoderToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: QoderUserContent[];
  isError: boolean;
}

export type QoderMessage = QoderUserMessage | QoderAssistantMessage | QoderToolResultMessage;

export interface QoderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface QoderCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface QoderUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextPercent?: number;
  credits?: number;
  creditUnit?: string;
  cacheEstimated?: boolean;
  cost: QoderCost;
}

export type QoderStreamEvent =
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
  | { type: "usage"; usage: QoderUsage }
  | {
      type: "done";
      stopReason: "stop" | "toolUse" | "length";
      errorMessage?: string;
      responseId?: string;
      upstreamModel?: string;
    };

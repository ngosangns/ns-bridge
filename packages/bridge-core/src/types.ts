// ABOUTME: Host-neutral vocabulary every vendor core and host bridge in ns-bridge speaks.
// ABOUTME: Vendor cores (kiro-core, devin-core) emit this shape; host bridges consume it.

/** User-facing reasoning levels, ordered least to most intensive. */
export type BridgeEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const BRIDGE_EFFORT_ORDER: readonly BridgeEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface BridgeTextContent {
  type: "text";
  text: string;
}
export interface BridgeImageContent {
  type: "image";
  /** Base64-encoded bytes, without a data-URL prefix. */
  data: string;
  mimeType: string;
}
export interface BridgeThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface BridgeToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type BridgeUserContent = BridgeTextContent | BridgeImageContent;
export type BridgeAssistantContent = BridgeTextContent | BridgeThinkingContent | BridgeToolCallContent;

/** Why the previous assistant turn stopped; only `length` changes request shaping in the cores. */
export type BridgeStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface BridgeUserMessage {
  role: "user";
  content: BridgeUserContent[];
}
export interface BridgeAssistantMessage {
  role: "assistant";
  content: BridgeAssistantContent[];
  stopReason?: BridgeStopReason;
  /** The vendor's own id for this turn, when it issued one (Devin threads replies on it). */
  responseId?: string;
}
export interface BridgeToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: BridgeUserContent[];
  isError: boolean;
}

export type BridgeMessage = BridgeUserMessage | BridgeAssistantMessage | BridgeToolResultMessage;

/** One tool offered to the model, in JSON-schema form. */
export interface BridgeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Provider-enforced strict schema conformance, when the host exposes it. */
  strict?: boolean;
}

export interface BridgeCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Usage for one response. Fields a vendor does not report stay absent rather
 * than zero, so a host can tell "not reported" from "none".
 */
export interface BridgeUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Percentage of the context window the vendor reported for this turn. */
  contextPercent?: number;
  /** Amount the vendor billed for this turn, in {@link creditUnit}. */
  credits?: number;
  creditUnit?: string;
  /** Set when {@link cacheRead} is an estimate rather than a wire counter. */
  cacheEstimated?: boolean;
  cost: BridgeCostBreakdown;
}

/**
 * An internal retry discarded everything emitted so far. Hosts able to drop
 * already-delivered blocks should; hosts that cannot may ignore this, because
 * the blocks that follow carry fresh indexes.
 */
export interface BridgeResetEvent {
  type: "reset";
}

/**
 * What a vendor core emits while a response streams. Block indexes are
 * allocated monotonically and never reused.
 */
export type BridgeStreamEvent =
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
      /** Parsed arguments (a core may mark unparseable JSON inside). */
      arguments: Record<string, unknown>;
      /** The raw argument JSON exactly as the model produced it, when the core keeps it. */
      argumentsJson?: string;
    }
  | BridgeResetEvent
  | { type: "usage"; usage: BridgeUsage }
  | {
      type: "done";
      stopReason: "stop" | "toolUse" | "length";
      /** Terminal diagnostic for a turn that finished but produced less than the model sent. */
      errorMessage?: string;
      /** The vendor's own id for this turn. */
      responseId?: string;
      /** Concrete model a router landed on, when it differs from the requested one. */
      upstreamModel?: string;
    };

/** A neutral request context: what every vendor core reads. */
export interface BridgeContext {
  systemPrompt?: string;
  messages: BridgeMessage[];
  tools?: BridgeTool[];
}

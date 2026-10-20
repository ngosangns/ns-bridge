// ABOUTME: The Grok agent CLI's model vocabulary.
// ABOUTME: Host-neutral: no Pi or Harness type appears here.

/** Reasoning effort levels the Grok CLI accepts. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GrokModelDescriptor {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoningEffort?: boolean;
}

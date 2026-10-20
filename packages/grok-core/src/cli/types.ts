// ABOUTME: The Grok CLI's model vocabulary.
// ABOUTME: Host-neutral: no Pi or Harness type appears here.

export interface GrokModelDescriptor {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoningEffort?: boolean;
}

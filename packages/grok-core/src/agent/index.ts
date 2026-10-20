// ABOUTME: The Grok agent CLI protocol: binary discovery, model discovery, and ACP over stdio.
// ABOUTME: Host-neutral. A host supplies its own identity, cache directory, and prompt shaping.

export {
  type AcpClientInfo,
  AcpJsonRpcClient,
  type AcpNotificationHandler,
  type AcpSpawnOptions,
  buildAcpArgs,
  createLiveAcpSession,
  DEFAULT_ACP_CLIENT_INFO,
  type JsonRpcMessage,
  type LiveAcpSession,
  promptAcpSession,
} from "./acp-client.js";
export { getGrokVersion, probeGrokAuth, resolveGrokBinary } from "./binary.js";
export { discoverGrokModels, parseGrokModelsOutput, resolveCliModelId } from "./models.js";
export type {
  AcpInitializeResult,
  AcpPromptMeta,
  AcpPromptResult,
  AcpSessionResult,
  GrokEndEvent,
  GrokErrorEvent,
  GrokModelDescriptor,
  GrokNdjsonMessage,
  GrokTextEvent,
  GrokThoughtEvent,
  IntegrationMode,
  ReasoningEffort,
} from "./types.js";

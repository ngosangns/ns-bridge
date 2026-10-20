// Public surface of the host-neutral Grok core. Host adapters translate its events.

export { grokAuthCandidates, loadGrokAccess, pickGrokAccount, resetGrokAuthCacheForTests } from "./auth.js";
export { GROK_LOGIN_MESSAGE, GrokApiError, GrokAuthError } from "./errors.js";
export {
  FALLBACK_GROK_CLIENT_VERSION,
  grokProxyBase,
  grokResponseHeaders,
  resolveGrokClientVersion,
} from "./headers.js";
export { buildResponsesBody, grokWireModelId, toResponsesInput } from "./request.js";
export { createResponsesState, finishResponses, parseSseJson, reduceResponsesEvent } from "./sse.js";
export { type StreamGrokOptions, streamGrok } from "./stream.js";
export type {
  GrokAssistantContent,
  GrokAssistantMessage,
  GrokCost,
  GrokEffort,
  GrokImageContent,
  GrokMessage,
  GrokStopReason,
  GrokStreamEvent,
  GrokTextContent,
  GrokThinkingContent,
  GrokTool,
  GrokToolCallContent,
  GrokToolResultMessage,
  GrokUsage,
  GrokUserContent,
  GrokUserMessage,
} from "./types.js";
export { toGrokUsage } from "./usage.js";

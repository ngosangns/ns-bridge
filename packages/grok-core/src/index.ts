// Public surface of the host-neutral Grok core. Host adapters translate its events.

export { grokAuthCandidates, loadGrokAccess, pickGrokAccount, resetGrokAuthCacheForTests } from "./auth.js";
export {
  GROK_BOOTSTRAP_MODEL_IDS,
  GROK_CATALOG_CACHE_DIR_ENV,
  GROK_CATALOG_FILE,
  GROK_CATALOG_PROVIDER_ID,
  GROK_DEFAULT_CONTEXT_WINDOW,
  GROK_DEFAULT_MAX_TOKENS,
  GROK_DEFAULT_MODEL_ID,
  type GrokCatalogSnapshot,
  type GrokModelSpec,
  grokBootstrapModels,
  grokCatalogPath,
  grokModelsFromCatalogJson,
  readGrokCatalog,
  withGrokCompaction,
} from "./catalog.js";
export { GROK_LOGIN_MESSAGE, GrokApiError, GrokAuthError } from "./errors.js";
export {
  FALLBACK_GROK_CLIENT_VERSION,
  grokProxyBase,
  grokResponseHeaders,
  resolveGrokClientVersion,
} from "./headers.js";
export {
  buildResponsesBody,
  estimateResponsesTokens,
  fitResponsesBody,
  toResponsesInput,
} from "./request.js";
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

// Public surface of the host-neutral Arnict core. Host adapters translate its events.

export {
  ARNICT_API_KEY_ENV,
  ARNICT_CONFIG_PATH_ENV,
  arnictConfigPath,
  clearArnictApiKey,
  loadArnictApiKey,
  maskArnictKey,
  type ResolveArnictApiKeyOptions,
  type ResolvedArnictApiKey,
  resolveArnictApiKey,
  writeArnictApiKey,
} from "./auth.js";
export {
  ARNICT_CATALOG_CACHE_DIR_ENV,
  ARNICT_CATALOG_FILE,
  ARNICT_CATALOG_PROVIDER_ID,
  ARNICT_DEFAULT_CONTEXT_WINDOW,
  ARNICT_DEFAULT_MAX_TOKENS,
  ARNICT_DEFAULT_MODEL_ID,
  ARNICT_KNOWN_MODELS,
  type ArnictCatalogSnapshot,
  type ArnictModelSpec,
  type ArnictRates,
  arnictBootstrapModels,
  arnictCatalogPath,
  arnictModelSpec,
  arnictModelsFromCatalogJson,
  arnictModelsFromModelIds,
  readArnictCatalog,
  withArnictCompaction,
} from "./catalog.js";
export { ARNICT_LOGIN_MESSAGE, ArnictApiError, ArnictAuthError, arnictApiErrorFromResponse } from "./errors.js";
export { fetchArnictModelIds } from "./models-api.js";
export { buildChatCompletionsBody } from "./request.js";
export {
  type ChatReduceState,
  chatCompletionChunks,
  createChatState,
  finishChat,
  parseSseData,
  reduceChatChunk,
  type WireChatChunk,
  type WireChatCompletion,
  type WireChoice,
  type WireToolCallDelta,
} from "./sse.js";
export {
  ARNICT_BASE_URL_ENV,
  ARNICT_DEFAULT_BASE_URL,
  arnictBaseUrl,
  type StreamArnictOptions,
  streamArnict,
} from "./stream.js";
export type {
  ArnictAssistantContent,
  ArnictAssistantMessage,
  ArnictCost,
  ArnictEffort,
  ArnictImageContent,
  ArnictMessage,
  ArnictStopReason,
  ArnictStreamEvent,
  ArnictTextContent,
  ArnictThinkingContent,
  ArnictTool,
  ArnictToolCallContent,
  ArnictToolResultMessage,
  ArnictUsage,
  ArnictUserContent,
  ArnictUserMessage,
} from "./types.js";
export { type ArnictWireUsage, toArnictUsage } from "./usage.js";

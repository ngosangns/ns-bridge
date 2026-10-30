// Public surface of the host-neutral Qoder core.

export {
  QODER_PAT_ENV,
  type QoderAuthMode,
  qoderConfigDir,
  qodercliSessionPresent,
  type ResolvedQoderAuth,
  requireQoderAuth,
  resolveQoderAuth,
} from "./auth.js";
export {
  QODER_CATALOG_CACHE_DIR_ENV,
  QODER_CATALOG_FILE,
  QODER_CATALOG_PROVIDER_ID,
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_DEFAULT_MAX_TOKENS,
  QODER_DEFAULT_MODEL_ID,
  type QoderCatalogSnapshot,
  type QoderModelInfoFields,
  type QoderModelSpec,
  qoderBootstrapModels,
  qoderCatalogPath,
  qoderModelFromInfo,
  qoderModelsFromCatalogJson,
  qoderModelsFromModelInfos,
  readQoderCatalog,
} from "./catalog.js";
export { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "./errors.js";
export { fetchQoderModels } from "./models-api.js";
export type {
  QoderWireAssistantMessage,
  QoderWireContentPart,
  QoderWireImagePart,
  QoderWireMessage,
  QoderWireSystemMessage,
  QoderWireTextPart,
  QoderWireToolCall,
  QoderWireToolMessage,
  QoderWireUserMessage,
} from "./prompt.js";
export { toQoderWireMessages } from "./prompt.js";
export { createWireReduceState, finishWireReduce, reduceWireChunk, type WireReduceState } from "./reduce.js";
export { qoderSessionId } from "./session.js";
export { qoderWireUrl, type StreamQoderOptions, streamQoder } from "./stream.js";
export type {
  QoderAssistantContent,
  QoderAssistantMessage,
  QoderEffort,
  QoderMessage,
  QoderStreamEvent,
  QoderTool,
  QoderToolResultMessage,
  QoderUsage,
  QoderUserContent,
  QoderUserMessage,
} from "./types.js";

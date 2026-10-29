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
export { buildQoderPrompt, collectQoderImages, qoderImageData } from "./prompt.js";
export { createSdkReduceState, finishSdkReduce, reduceSdkMessage, type SdkReduceState } from "./sdk-reduce.js";
export { qoderSessionId } from "./session.js";
export { type QueryFactory, type StreamQoderOptions, streamQoder } from "./stream.js";
export { createHostToolMcpServer } from "./tools.js";
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

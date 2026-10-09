// Public surface of the host-neutral Devin (Cascade) core.
// Vendor wire protocol (Connect framing, request building, streaming) runs in
// the Go sidecar; what remains here is the host-facing vocabulary, credential
// store, model cache, and fail-soft facades.

export {
  DEFAULT_DEVIN_CAPACITY_RETRY,
  type DevinCapacityRetryPolicy,
  streamDevinWithCapacityRetry,
} from "./capacity-retry.js";
export {
  type DevinStoredCredentials,
  devinCredentialsPath,
  resolveDevinCredentials,
  resolveDevinSession,
  saveDevinCredentials,
} from "./credentials.js";
export { type DevinModelDiscoveryOptions, fetchDevinModels } from "./discovery.js";
export { DEVIN_SIDECAR_VENDOR, devinErrorFromSidecar, toDevinSidecarRequest } from "./engine.js";
export {
  DevinApiError,
  DevinProtocolError,
  DevinStreamError,
  isDevinAuthError,
  isDevinCapacityError,
  isDevinContextOverflowError,
  isDevinRateLimitError,
  parseRetryAfterMs,
} from "./errors.js";
export {
  DEVIN_MODEL_IDS,
  devinModelCachePath,
  devinModels,
  getCachedModels,
  isCacheStale,
  resolveDevinModel,
  updateDevinModelsCache,
} from "./models.js";
export {
  credentialsFromToken,
  type DevinAuthMethod,
  type DevinCredentials,
  type DevinLoginCallbacks,
  isDevinApiKey,
  isExpired,
  loginDevinWithPkce,
  refreshDevinToken,
} from "./oauth.js";
export {
  calculateDevinCost,
  type DevinStreamRequest,
  LARGE_HISTORY_RECOVERY_BYTES,
  streamDevin,
} from "./stream.js";
export * from "./types.js";
export {
  type DevinProviderUsage,
  type DevinUsageFetchOptions,
  type DevinUsageLimit,
  type DevinUsageUnit,
  type DevinUsageWindowId,
  fetchDevinUsage,
} from "./usage.js";
export {
  type DeterministicUuid,
  type DevinLogger,
  deterministicUuid,
  isRecord,
  logger,
  normalizeSystemPrompts,
  redactSensitiveCredentials,
  sanitizeText,
} from "./util.js";
export {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_MANAGEMENT_BASE_URL,
  DEVIN_SESSION_TOKEN_PREFIX,
  DEVIN_WEBAPP_URL,
  normalizeDevinSessionToken,
} from "./wire.js";

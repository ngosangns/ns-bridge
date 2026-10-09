// Public surface of the host-neutral Kiro core.
// Vendor wire protocol (requests, streaming, retries, catalog and usage RPCs)
// runs in the Go sidecar; what remains here is the host-facing vocabulary,
// credential-store orchestration, model catalog caches, and sidecar facades.

export { applyCacheEstimate, resetCacheEstimatorForTests } from "./cache-estimator.js";
export { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
export {
  buildKiroAdditionalModelRequestFields,
  clampKiroEffort,
  deriveKiroEffort,
  fallbackKiroEffort,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
  type KiroEffortConfig,
  type KiroEffortField,
  mapEffortToKiroValue,
} from "./effort.js";
export {
  getKiroEndpoints,
  getKiroRegionFromEndpoint,
  getKiroRegionFromProfileArn,
  KIRO_MANAGEMENT_ENDPOINT_ENV,
  KIRO_RUNTIME_ENDPOINT_ENV,
  type KiroEndpoints,
  resolveApiRegion,
} from "./endpoints.js";
export { KIRO_SIDECAR_VENDOR, SidecarError, streamKiroOnEngine, toKiroSidecarRequest } from "./engine.js";
export { kiroErrorFromSidecar, runKiroOp } from "./engine-ops.js";
export {
  extractKiroReasonCode,
  KiroApiError,
  type KiroProviderAttempts,
  parseRetryAfterMs,
} from "./errors.js";
export {
  KIRO_NO_SESSION_MESSAGE,
  type KiroHostLoginCallbacks,
  loginKiroFromSession,
  type ResolvedKiroRequestCredentials,
  resolveKiroRequestCredentials,
} from "./host-auth.js";
export { type KiroHostModel, toKiroModelForHost } from "./host-model.js";
export {
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroCliDbPath,
  getKiroCliExternalIdpCredentials,
  getKiroCliModelRates,
  getKiroCliSocialToken,
  getKiroCliSocialTokenAllowExpired,
  type KiroModelRate,
  refreshViaKiroCli,
  saveKiroCliCredentials,
} from "./kiro-cli.js";
export { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
export {
  applyKiroProfileArnCacheChanges,
  applyKiroProfileRegionChanges,
  invalidateKiroProfileArn,
  type KiroGetUsageLimitsRequest,
  KiroManagementHttpError,
  resetKiroProfileArnCache,
  snapshotKiroProfileArnCache,
  snapshotKiroProfileRegionCache,
} from "./management.js";
export {
  applyEffortLadder,
  getCachedModels,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  KIRO_MODEL_IDS,
  type KiroModel,
  kiroModels,
  loadCachedModelIds,
  resolveKiroModel,
  updateKiroModelsCache,
} from "./models.js";
export {
  BUILDER_ID_PROFILE_ARN,
  BUILDER_ID_START_URL,
  isApiKey,
  isExpired,
  type KiroAuthMethod,
  type KiroAuthSource,
  type KiroCredentials,
  loginKiroWithApiKey,
  refreshKiroToken,
  resolveKiroAuthSource,
  resolveKiroCredentials,
  SSO_OIDC_ENDPOINT,
  SSO_SCOPES,
} from "./oauth.js";
export {
  CAPACITY_PATTERN,
  capacityRetryConfig,
  firstTokenTimeoutForModel,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  type KiroReasonCode,
  NON_RETRYABLE_BODY_PATTERNS,
  retryConfig,
} from "./retry.js";
export { type KiroStreamRequest, resetProfileArnCache, streamKiro, testProfileArnOverride } from "./stream.js";
export * from "./types.js";
export {
  fetchKiroUsage,
  type KiroGetUsageLimitsResponse,
  type KiroProviderUsage,
  type KiroProviderUsageBucket,
} from "./usage.js";
export {
  DEFAULT_USD_PER_CREDIT,
  estimateKiroCreditCost,
  KIRO_USAGE_TRACKING_DISABLED,
  type KiroUsageTracking,
  resolveKiroUsageTracking,
} from "./usage-tracking.js";

// Public surface of the host-neutral Kiro core.
//
// This is the floor a host actually reaches for, plus the stage entry points
// and the error vocabulary. Everything else stays importable from its own
// module inside this package (tests do exactly that) but is not part of the
// package entry point: a name with no consumer outside this package was an
// accident of `export *`-style growth, and publishing it makes the next
// internal rename a breaking change.
//
// Smithy and js-tiktoken are required on first use inside response-stream and
// tokenizer, so importing this barrel does not evaluate them.

// The stages `streamKiro` runs in order. Exported so a caller can drive one on
// its own — building a request without sending it, or assembling blocks from
// events it sourced elsewhere — which is what splitting them apart was for.
export { KiroBlockBuffer } from "./blocks.js";
export { calculateKiroCost } from "./cost.js";
export { formatSafeError } from "./debug.js";
export { getKiroEndpoints, getKiroRegionFromEndpoint, resolveApiRegion } from "./endpoints.js";
export { KiroApiError } from "./errors.js";
export { parseKiroEvent } from "./event-parser.js";
export {
  loginKiroFromSession,
  type ResolvedKiroRequestCredentials,
  resolveKiroRequestCredentials,
} from "./host-auth.js";
export { toKiroModelForHost } from "./host-model.js";
export { getKiroCliModelRates } from "./kiro-cli.js";
export {
  getCachedModels,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  type KiroModel,
  kiroModels,
  updateKiroModelsCache,
} from "./models.js";
export { isExpired, type KiroCredentials, readKiroSession, refreshKiroToken, resolveKiroCredentials } from "./oauth.js";
export {
  type BuildKiroRequestParams,
  type BuiltKiroRequest,
  buildKiroRequest,
  type KiroRequest,
} from "./request-builder.js";
export { type KiroAttemptSummary, type KiroCompletedResponse, KiroResponseAssembler } from "./response-assembler.js";
export {
  IDLE_TIMEOUT,
  type KiroEventStreamOptions,
  type KiroEventStreamOutcome,
  type KiroEventStreamReader,
  type KiroWireEventFrame,
  readKiroEventStream,
} from "./response-stream.js";
// Kiro's own error vocabulary and the predicates this core classifies it with.
// Published so consumers can interpret a reason code without an error instance
// in hand (a persisted log line, say) instead of hardcoding copies of the
// literals, which drift when the service adds a code.
export {
  CAPACITY_PATTERN,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  type KiroReasonCode,
  NON_RETRYABLE_BODY_PATTERNS,
  TOO_BIG_PATTERNS,
} from "./retry.js";
export { type KiroStreamRequest, streamKiro } from "./stream.js";
export { countTokens } from "./tokenizer.js";
export {
  abortableDelay,
  createResponseHeaderDeadline,
  logCapacityEvent,
  type ResponseHeaderDeadline,
} from "./transport.js";
export * from "./types.js";
export { fetchKiroUsage, type KiroProviderUsage, type KiroProviderUsageBucket } from "./usage.js";
export {
  DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
  DEFAULT_USD_PER_CREDIT,
  estimateKiroCreditCost,
  KIRO_USAGE_TRACKING_DISABLED,
  type KiroUsageTracking,
  resolveKiroUsageTracking,
} from "./usage-tracking.js";

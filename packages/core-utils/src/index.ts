// ABOUTME: Plumbing every vendor core needs and none of them owns.
// ABOUTME: Deliberately dependency-free and host-free: cores depend on this, never the reverse.

export { readJsonFile, writeJsonFileAtomic } from "./cache.js";
export {
  COMPACTION_RESERVE_FLOOR,
  type CompactionBudget,
  type CompactionBudgetInput,
  compactionBudget,
} from "./compaction.js";
export {
  exponentialBackoff,
  headerRecordSource,
  parseRetryAfterMs,
  type RetryHeaderSource,
} from "./retry.js";
export { abortableDelay } from "./timing.js";
export {
  buildUsageRecord,
  type CacheSource,
  getUsageHost,
  pruneUsage,
  recordUsage,
  resetUsageLedgerForTests,
  setUsageHost,
  USAGE_MAX_BYTES,
  USAGE_RETENTION_DAYS,
  type UsageContext,
  type UsageHost,
  type UsageRecord,
  usageDay,
  usageFileName,
  usageRecordingEnabled,
  usageRoot,
  usageWriteFailures,
  writeUsageRecord,
} from "./usage-ledger.js";

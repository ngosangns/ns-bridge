// ABOUTME: Plumbing every vendor core needs and none of them owns.
// ABOUTME: Deliberately dependency-free and host-free: cores depend on this, never the reverse.

export { readJsonFile, writeJsonFileAtomic } from "./cache.js";
export {
  exponentialBackoff,
  headerRecordSource,
  parseRetryAfterMs,
  type RetryHeaderSource,
} from "./retry.js";
export { abortableDelay } from "./timing.js";

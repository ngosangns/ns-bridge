// ABOUTME: Devin model discovery — GetCliModelConfigs runs in the Go vendor
// ABOUTME: (dual native/legacy identity, effort-lane collapse); this facade
// ABOUTME: keeps the fail-soft contract and cache writes.

import type { DevinModelSpec } from "./types.js";

/** Options for {@link fetchDevinModels}. */
export interface DevinModelDiscoveryOptions {
  /** Session token carried inside `Metadata.apiKey`. */
  apiKey?: string;
  /** Cascade API base URL override. */
  baseUrl?: string;
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch the account's model catalog through `GetCliModelConfigs`, normalized
 * onto {@link DevinModelSpec}s by the Go vendor. Returns `null` on
 * request/decode failure; `[]` never escapes — an empty-but-200 response is
 * treated as failure so a caller's static seed survives a stale pinned
 * identity.
 */
export async function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<DevinModelSpec[] | null> {
  const { runDevinOp } = await import("./engine-ops.js");
  return runDevinOp<DevinModelSpec[] | null, DevinModelSpec[] | null>({
    op: "models",
    request: () => ({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
    fromWire: (models) => (Array.isArray(models) && models.length > 0 ? models : null),
    fallback: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

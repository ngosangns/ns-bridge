// ABOUTME: Account quota from Qoder's center API. Hosts project the buckets.

import { resolveQoderAuth } from "./auth.js";
import { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "./errors.js";

const QUOTA_ORIGIN = "https://center.qoder.sh";

export interface QoderQuotaBucket {
  id: string;
  label: string;
  used: number;
  limit: number;
  remaining?: number;
  unit: "credits";
}

/** Host-neutral quota. `raw` is the usage payload with account ids removed. */
export interface QoderQuota {
  planName?: string;
  resetsAt?: number;
  manageUrl?: string;
  buckets: QoderQuotaBucket[];
  raw: unknown;
}

export interface FetchQoderQuotaOptions {
  /** Pass `null` when the caller already knows there is no session. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const BUCKETS: readonly { key: string; id: string; label: string }[] = [
  { key: "userQuota", id: "user", label: "Plan credits" },
  { key: "addOnQuota", id: "addon", label: "Add-on credits" },
  { key: "orgResourcePackage", id: "org", label: "Organization credits" },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://") ? value : undefined;
}

function bucketFrom(id: string, label: string, value: unknown): QoderQuotaBucket | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const limit = positiveNumber(record.total) ?? positiveNumber(record.cap);
  if (limit === undefined) return undefined;
  const used = finiteNumber(record.used) ?? 0;
  const remaining = finiteNumber(record.remaining);
  return {
    id,
    label,
    used,
    limit,
    ...(remaining !== undefined ? { remaining } : {}),
    unit: "credits",
  };
}

/** Drop account identifiers before a host stores the payload beside the report. */
function rawWithoutAccount(usage: Record<string, unknown>): Record<string, unknown> {
  const raw = { ...usage };
  delete raw.userId;
  delete raw.user_id;
  return raw;
}

/**
 * Buckets with a positive `total` or `cap`. A zero-total placeholder is absent
 * on this seat, so publishing it would show an empty plan row.
 */
export function parseQoderQuota(usageBody: unknown, planBody?: unknown): QoderQuota | null {
  const usage = asRecord(usageBody);
  if (!usage) return null;
  const plan = asRecord(planBody);
  const planName = typeof plan?.plan_tier_name === "string" ? plan.plan_tier_name.trim() : "";
  const resetsAt = finiteNumber(usage.expiresAt) ?? finiteNumber(usage.refreshAt);
  const addOn = asRecord(usage.addOnQuota);
  const manageUrl = httpUrl(addOn?.detailUrl) ?? httpUrl(usage.upgradeUrl);
  return {
    ...(planName ? { planName } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(manageUrl ? { manageUrl } : {}),
    buckets: BUCKETS.flatMap((entry) => {
      const bucket = bucketFrom(entry.id, entry.label, usage[entry.key]);
      return bucket ? [bucket] : [];
    }),
    raw: rawWithoutAccount(usage),
  };
}

async function getJson(fetchImpl: typeof fetch, token: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(`${QUOTA_ORIGIN}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new QoderAuthError(`${QODER_LOGIN_MESSAGE} (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new QoderApiError(`Qoder quota endpoint returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/** Quota for the local qodercli session. No session returns null. A plan failure keeps the usage buckets. */
export async function fetchQoderQuota(options: FetchQoderQuotaOptions = {}): Promise<QoderQuota | null> {
  const token = options.token !== undefined ? options.token || undefined : resolveQoderAuth()?.token;
  if (!token) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [usageResult, planResult] = await Promise.allSettled([
    getJson(fetchImpl, token, "/api/v2/quota/usage", options.signal),
    getJson(fetchImpl, token, "/api/v2/user/plan", options.signal),
  ]);
  if (usageResult.status === "rejected") throw usageResult.reason;
  const plan = planResult.status === "fulfilled" ? planResult.value : undefined;
  return parseQoderQuota(usageResult.value, plan);
}

// ABOUTME: Fetches Kiro account usage through the current Kiro management control plane.
// ABOUTME: Maps the response into a host-neutral shape each adapter projects for its own UI.

import { resolveApiRegion } from "./endpoints.js";
import { getUsageLimits, type KiroManagementAuth, kiroProfileAuth, resolveKiroProfileArn } from "./management.js";
import type { KiroCredentials } from "./oauth.js";

const MANAGE_USAGE_URL = "https://app.kiro.dev/account/usage";

type EpochLike = number | string;

interface KiroFreeTrialInfo {
  freeTrialStatus?: string;
  freeTrialExpiry?: EpochLike;
  currentUsage?: number;
  currentUsageWithPrecision?: number;
  usageLimit?: number;
  usageLimitWithPrecision?: number;
}

interface KiroUsageBreakdown {
  resourceType?: string;
  displayName?: string;
  displayNamePlural?: string;
  currentUsage: number;
  currentUsageWithPrecision?: number;
  currentOverages: number;
  currentOveragesWithPrecision?: number;
  usageLimit: number;
  usageLimitWithPrecision?: number;
  unit?: string;
  overageCharges: number;
  currency?: string;
  overageRate?: number;
  nextDateReset?: EpochLike;
  overageCap?: number;
  overageCapWithPrecision?: number;
  freeTrialInfo?: KiroFreeTrialInfo;
}

interface KiroUsageLimitList {
  type?: string;
  currentUsage?: number;
  totalUsageLimit?: number;
  percentUsed?: number;
}

export interface KiroGetUsageLimitsResponse {
  limits?: KiroUsageLimitList[];
  nextDateReset?: EpochLike;
  daysUntilReset?: number;
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
  subscriptionInfo?: { subscriptionTitle?: string };
  overageConfiguration?: { overageStatus?: string };
  userInfo?: { userId?: string; email?: string };
}

/**
 * What a bucket counts. The wire writes Kiro's credit bucket as `INVOCATIONS`,
 * and sometimes leaves `unit` out, so hosts read this instead of `unit`.
 */
export type KiroUsageUnit = "credits" | "requests" | "tokens" | "usd" | "unknown";

export interface KiroProviderUsageBonus {
  label: string;
  usedDisplay?: string;
  limitDisplay?: string;
  expiresAt?: string;
}

export interface KiroProviderUsageBucket {
  id: string;
  label: string;
  resourceType?: string;
  /** Raw amounts, for hosts that render their own gauges. */
  used: number;
  limit?: number;
  overages?: number;
  usedDisplay: string;
  limitDisplay?: string;
  unit?: string;
  /** Normalized from `unit` and `resourceType`. */
  unitKind?: KiroUsageUnit;
  overagesDisplay?: string;
  overageChargesDisplay?: string;
  resetAt?: string;
  /** The same instant as `resetAt`, in milliseconds since the epoch. */
  resetAtMs?: number;
  bonus?: KiroProviderUsageBonus;
}

export interface KiroProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  /** The same instant as `resetAt`, in milliseconds since the epoch. */
  resetAtMs?: number;
  daysUntilReset?: number;
  overageStatus?: string;
  manageUrl?: string;
  usageBuckets?: KiroProviderUsageBucket[];
  raw?: Record<string, unknown>;
}

/**
 * Resets arrive as epoch seconds and, on some responses, as a date string.
 * Both become milliseconds since the epoch, the one shape hosts can compare.
 */
function toEpochMs(value: EpochLike | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function toIsoDate(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return new Date(ms).toISOString();
}

/**
 * The wire names the credit bucket `INVOCATIONS` and sometimes omits `unit`.
 * `resourceType` is the reliable signal for those buckets.
 */
function toUsageUnit(unit: string | undefined, resourceType: string | undefined): KiroUsageUnit {
  const named = unit?.toLowerCase();
  if (resourceType?.toLowerCase() === "credit" && (named === undefined || named === "invocations")) return "credits";
  switch (named) {
    case "credit":
    case "credits":
      return "credits";
    case "request":
    case "requests":
      return "requests";
    case "token":
    case "tokens":
      return "tokens";
    case "usd":
      return "usd";
    default:
      return "unknown";
  }
}

function formatCount(value: number | undefined): string | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(amount: number | undefined, currency: string | undefined): string | undefined {
  if (amount === undefined || Number.isNaN(amount) || amount <= 0) return undefined;
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function mapBucket(bucket: KiroUsageBreakdown, index: number): KiroProviderUsageBucket {
  const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
  const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages;
  const freeTrialUsed = bucket.freeTrialInfo?.currentUsageWithPrecision ?? bucket.freeTrialInfo?.currentUsage;
  const freeTrialLimit = bucket.freeTrialInfo?.usageLimitWithPrecision ?? bucket.freeTrialInfo?.usageLimit;
  const resetAtMs = toEpochMs(bucket.nextDateReset);

  return {
    id: bucket.resourceType || bucket.displayName || `usage-${index}`,
    label: bucket.displayName || bucket.displayNamePlural || bucket.resourceType || "Usage",
    resourceType: bucket.resourceType,
    used: used ?? 0,
    limit,
    overages: overages && overages > 0 ? overages : undefined,
    usedDisplay: formatCount(used) || "0",
    limitDisplay: formatCount(limit),
    unit: bucket.unit,
    unitKind: toUsageUnit(bucket.unit, bucket.resourceType),
    overagesDisplay: overages && overages > 0 ? formatCount(overages) : undefined,
    overageChargesDisplay: formatMoney(bucket.overageCharges, bucket.currency),
    resetAt: toIsoDate(resetAtMs),
    resetAtMs,
    bonus:
      freeTrialUsed !== undefined || freeTrialLimit !== undefined || bucket.freeTrialInfo?.freeTrialExpiry !== undefined
        ? {
            label: "Bonus credits",
            usedDisplay: formatCount(freeTrialUsed),
            limitDisplay: formatCount(freeTrialLimit),
            expiresAt: toIsoDate(toEpochMs(bucket.freeTrialInfo?.freeTrialExpiry)),
          }
        : undefined,
  };
}

async function fetchRawUsage(auth: KiroManagementAuth, profileArn?: string): Promise<KiroGetUsageLimitsResponse> {
  const resolvedProfileArn = await resolveKiroProfileArn(auth, profileArn);
  return getUsageLimits<KiroGetUsageLimitsResponse>(kiroProfileAuth(auth, resolvedProfileArn), {
    profileArn: resolvedProfileArn,
    origin: "KIRO_CLI",
    resourceType: "CREDIT",
    isEmailRequired: false,
  });
}

export async function fetchKiroUsage(credentials: KiroCredentials): Promise<KiroProviderUsage> {
  const auth = { accessToken: credentials.access, region: resolveApiRegion(credentials.region) };
  const raw = await fetchRawUsage(auth, credentials.profileArn);
  const usageBuckets = raw.usageBreakdownList?.length
    ? raw.usageBreakdownList.map(mapBucket)
    : raw.usageBreakdown
      ? [mapBucket(raw.usageBreakdown, 0)]
      : [];
  const resetAtMs = toEpochMs(raw.nextDateReset);

  return {
    summary: raw.subscriptionInfo?.subscriptionTitle,
    subscriptionTitle: raw.subscriptionInfo?.subscriptionTitle,
    resetAt: toIsoDate(resetAtMs),
    resetAtMs,
    daysUntilReset: raw.daysUntilReset,
    overageStatus: raw.overageConfiguration?.overageStatus,
    manageUrl: MANAGE_USAGE_URL,
    usageBuckets,
    raw: raw as Record<string, unknown>,
  };
}

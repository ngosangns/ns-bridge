// ABOUTME: Fetches Kiro account usage through the management control plane.
// ABOUTME: The RPC and response shaping run in the Go vendor; this facade
// ABOUTME: keeps the host-neutral types.

export interface KiroGetUsageLimitsResponse {
  limits?: { type?: string; currentUsage?: number; totalUsageLimit?: number; percentUsed?: number }[];
  nextDateReset?: number | string;
  daysUntilReset?: number;
  usageBreakdown?: Record<string, unknown>;
  usageBreakdownList?: Record<string, unknown>[];
  subscriptionInfo?: { subscriptionTitle?: string };
  overageConfiguration?: { overageStatus?: string };
  userInfo?: { userId?: string; email?: string };
  [key: string]: unknown;
}

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
  overagesDisplay?: string;
  overageChargesDisplay?: string;
  resetAt?: string;
  bonus?: KiroProviderUsageBonus;
}

export interface KiroProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  daysUntilReset?: number;
  overageStatus?: string;
  manageUrl?: string;
  usageBuckets?: KiroProviderUsageBucket[];
  raw?: Record<string, unknown>;
}

import type { KiroCredentials } from "./oauth.js";

/** Fetch the account's usage through the Go vendor's `usage` op. */
export async function fetchKiroUsage(credentials: KiroCredentials): Promise<KiroProviderUsage> {
  const { runKiroOp } = await import("./engine-ops.js");
  return runKiroOp("usage", () => ({ credentials }));
}

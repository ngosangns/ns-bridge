/**
 * Projects Kiro account usage onto the report OMP's Usage panel reads.
 *
 * The quota call itself stays in ns-kiro-core (`fetchKiroUsage` →
 * GetUsageLimits). This file only speaks OMP's `UsageReport`.
 */

import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport, UsageUnit } from "@oh-my-pi/pi-ai";
import {
  fetchKiroUsage,
  type KiroCredentials,
  type KiroProviderUsage,
  type KiroProviderUsageBucket,
} from "ns-kiro-core";

/**
 * Kiro reports credit consumption. GetUsageLimits names that CREDIT bucket's
 * unit `INVOCATIONS` and sometimes omits it. The amounts are still credits.
 * Any other unit is passed through, or `unknown` when it is not one OMP knows.
 */
function toUsageUnit(unit: string | undefined, resourceType: string | undefined): UsageUnit {
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

function toResetMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function toLimit(provider: string, bucket: KiroProviderUsageBucket, usage: KiroProviderUsage) {
  const resetsAt = toResetMs(bucket.resetAt ?? usage.resetAt);
  const exhausted = bucket.limit !== undefined && bucket.used >= bucket.limit;
  const notes: string[] = [];
  if (bucket.overagesDisplay) notes.push(`Overage: ${bucket.overagesDisplay}`);
  if (bucket.overageChargesDisplay) notes.push(`Overage charges: ${bucket.overageChargesDisplay}`);
  if (bucket.bonus?.limitDisplay) {
    notes.push(`${bucket.bonus.label}: ${bucket.bonus.usedDisplay ?? "0"} / ${bucket.bonus.limitDisplay}`);
  }

  return {
    id: bucket.id,
    label: bucket.label,
    scope: { provider, ...(bucket.resourceType ? { tier: bucket.resourceType } : {}) },
    ...(resetsAt !== undefined ? { window: { id: "billing-period", label: "Billing period", resetsAt } } : {}),
    amount: {
      used: bucket.used,
      ...(bucket.limit !== undefined ? { limit: bucket.limit } : {}),
      unit: toUsageUnit(bucket.unit, bucket.resourceType),
    },
    // Kiro exposes no warning threshold of its own. Inventing one would put a
    // warning in front of the user that the service never raised.
    status: exhausted ? ("exhausted" as const) : ("ok" as const),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * OMP's usage panel over one `fetchKiroUsage` result.
 *
 * `fetchedAt` is injectable so a test can pin the timestamp the panel shows.
 */
export function toUsageReport(provider: string, usage: KiroProviderUsage, fetchedAt = Date.now()): UsageReport {
  return {
    provider,
    fetchedAt,
    limits: (usage.usageBuckets ?? []).map((bucket) => toLimit(provider, bucket, usage)),
    ...(usage.subscriptionTitle ? { notes: [usage.subscriptionTitle] } : {}),
    metadata: {
      ...(usage.manageUrl ? { manageUrl: usage.manageUrl } : {}),
      ...(usage.overageStatus ? { overageStatus: usage.overageStatus } : {}),
      ...(usage.daysUntilReset !== undefined ? { daysUntilReset: usage.daysUntilReset } : {}),
    },
    raw: usage.raw,
  };
}

/**
 * Credential OMP hands the panel, projected onto the Kiro session the core fetches.
 *
 * The host's auth storage is the source of the token: a user may hold several
 * Kiro accounts, and the panel reports the one it is asking about. Region
 * starts at us-east-1. GetUsageLimits is regional to the profile, and the
 * core probes the canonical regions from that starting point. An API key's
 * profile always lives in the key-issuing region; the core detects `ksk_`.
 */
function credentialsFor(params: UsageFetchParams): KiroCredentials | undefined {
  const token = params.credential.accessToken ?? params.credential.apiKey;
  if (!token) return undefined;
  return {
    access: token,
    refresh: "",
    expires: params.credential.expiresAt ?? 0,
    clientId: "",
    clientSecret: "",
    region: "us-east-1",
    authMethod: params.credential.type === "api_key" ? "apikey" : "idc",
  };
}

export const kiroUsageProvider: UsageProvider = {
  id: "kiro",

  async fetchUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
    const credentials = credentialsFor(params);
    if (!credentials) return null;
    const usage = await fetchKiroUsage(credentials);
    return toUsageReport(params.provider, usage);
  },

  validatesCredentials: true,
};

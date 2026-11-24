/**
 * Projects Qoder account quota onto the report OMP's Usage panel reads.
 *
 * The quota call stays in ns-qoder-core. This file only speaks OMP's `UsageReport`.
 * The apiKey OMP registers for Qoder is the placeholder "qoder-cli", so this
 * provider ignores that credential and lets the core read the qodercli session.
 */

import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { fetchQoderQuota, type QoderQuota, type QoderQuotaBucket } from "ns-qoder-core";

function toLimit(provider: string, bucket: QoderQuotaBucket, quota: QoderQuota) {
  const exhausted = bucket.remaining === 0 || bucket.used >= bucket.limit;
  return {
    id: bucket.id,
    label: bucket.label,
    scope: { provider },
    ...(quota.resetsAt !== undefined
      ? { window: { id: "billing-period", label: "Billing period", resetsAt: quota.resetsAt } }
      : {}),
    amount: {
      used: bucket.used,
      limit: bucket.limit,
      unit: "credits" as const,
    },
    status: exhausted ? ("exhausted" as const) : ("ok" as const),
  };
}

/** OMP's usage panel over one `fetchQoderQuota` result. */
export function toQoderUsageReport(provider: string, quota: QoderQuota, fetchedAt = Date.now()): UsageReport {
  return {
    provider,
    fetchedAt,
    limits: quota.buckets.map((bucket) => toLimit(provider, bucket, quota)),
    ...(quota.planName ? { notes: [quota.planName] } : {}),
    metadata: {
      ...(quota.manageUrl ? { manageUrl: quota.manageUrl } : {}),
    },
    raw: quota.raw,
  };
}

export const qoderUsageProvider: UsageProvider = {
  id: "qoder",

  async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
    const quota = await fetchQoderQuota({ fetchImpl: ctx.fetch });
    if (!quota) return null;
    return toQoderUsageReport(params.provider, quota);
  },

  validatesCredentials: false,
};

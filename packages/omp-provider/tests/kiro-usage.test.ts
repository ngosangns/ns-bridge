import type { KiroProviderUsage, KiroProviderUsageBucket } from "ns-kiro-core";
import { fetchKiroUsage } from "ns-kiro-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { kiroUsageProvider, toUsageReport } from "../src/kiro-usage.js";

vi.mock("ns-kiro-core", () => ({
  fetchKiroUsage: vi.fn(),
}));

const bucket = (overrides: Partial<KiroProviderUsageBucket> = {}): KiroProviderUsageBucket => ({
  id: "CREDIT",
  label: "Credits",
  resourceType: "CREDIT",
  used: 120,
  limit: 1000,
  usedDisplay: "120",
  limitDisplay: "1000",
  unit: "credit",
  ...overrides,
});

const usage = (overrides: Partial<KiroProviderUsage> = {}): KiroProviderUsage => ({
  subscriptionTitle: "Kiro Pro",
  resetAt: "2026-10-01T00:00:00.000Z",
  daysUntilReset: 27,
  manageUrl: "https://app.kiro.dev/account/usage",
  usageBuckets: [bucket()],
  ...overrides,
});

const ctx = { fetch };

describe("toUsageReport", () => {
  it("carries raw amounts rather than the display strings", () => {
    const report = toUsageReport("kiro", usage(), 1000);
    expect(report.limits[0]?.amount).toEqual({ used: 120, limit: 1000, unit: "credits" });
    expect(report.fetchedAt).toBe(1000);
    expect(report.provider).toBe("kiro");
    expect(report.notes).toEqual(["Kiro Pro"]);
    expect(report.metadata).toMatchObject({
      manageUrl: "https://app.kiro.dev/account/usage",
      daysUntilReset: 27,
    });
  });

  it("falls back to the account reset when a bucket declares none", () => {
    expect(toUsageReport("kiro", usage()).limits[0]?.window).toEqual({
      id: "billing-period",
      label: "Billing period",
      resetsAt: Date.parse("2026-10-01T00:00:00.000Z"),
    });
  });

  it("omits the window when neither the bucket nor the account has a reset", () => {
    expect(toUsageReport("kiro", usage({ resetAt: undefined })).limits[0]?.window).toBeUndefined();
  });

  it("reports an unknown unit rather than guessing", () => {
    const report = toUsageReport("kiro", usage({ usageBuckets: [bucket({ unit: "widget" })] }));
    expect(report.limits[0]?.amount.unit).toBe("unknown");
  });

  it("treats a CREDIT bucket whose unit is missing or INVOCATIONS as credits", () => {
    expect(toUsageReport("kiro", usage({ usageBuckets: [bucket({ unit: undefined })] })).limits[0]?.amount.unit).toBe(
      "credits",
    );
    expect(
      toUsageReport("kiro", usage({ usageBuckets: [bucket({ unit: "INVOCATIONS" })] })).limits[0]?.amount.unit,
    ).toBe("credits");
    const unnamed = usage({ usageBuckets: [bucket({ unit: undefined, resourceType: undefined })] });
    expect(toUsageReport("kiro", unnamed).limits[0]?.amount.unit).toBe("unknown");
  });

  it("marks a fully consumed bucket exhausted and everything else ok", () => {
    expect(toUsageReport("kiro", usage()).limits[0]?.status).toBe("ok");
    const spent = usage({ usageBuckets: [bucket({ used: 1000 })] });
    expect(toUsageReport("kiro", spent).limits[0]?.status).toBe("exhausted");
  });

  it("keeps a limitless bucket out of the exhausted state", () => {
    const unbounded = usage({ usageBuckets: [bucket({ limit: undefined })] });
    expect(toUsageReport("kiro", unbounded).limits[0]?.status).toBe("ok");
    expect(toUsageReport("kiro", unbounded).limits[0]?.amount).toEqual({ used: 120, unit: "credits" });
  });

  it("surfaces overage and bonus detail as notes", () => {
    const withExtras = usage({
      usageBuckets: [
        bucket({
          overagesDisplay: "12",
          overageChargesDisplay: "$4.80",
          bonus: { label: "Bonus credits", usedDisplay: "5", limitDisplay: "50" },
        }),
      ],
    });
    expect(toUsageReport("kiro", withExtras).limits[0]?.notes).toEqual([
      "Overage: 12",
      "Overage charges: $4.80",
      "Bonus credits: 5 / 50",
    ]);
  });

  it("reports no limits for an account with no buckets", () => {
    expect(toUsageReport("kiro", usage({ usageBuckets: [] })).limits).toEqual([]);
  });
});

describe("kiroUsageProvider.fetchUsage", () => {
  beforeEach(() => {
    vi.mocked(fetchKiroUsage).mockReset();
  });

  it("returns null when the credential has no token", async () => {
    await expect(
      kiroUsageProvider.fetchUsage({ provider: "kiro", credential: { type: "oauth" } }, ctx),
    ).resolves.toBeNull();
    expect(fetchKiroUsage).not.toHaveBeenCalled();
  });

  it("reports the oauth account OMP asked about", async () => {
    vi.mocked(fetchKiroUsage).mockResolvedValue(usage());
    const report = await kiroUsageProvider.fetchUsage(
      { provider: "kiro", credential: { type: "oauth", accessToken: "access-token", expiresAt: 50 } },
      ctx,
    );
    expect(report?.limits[0]?.amount).toEqual({ used: 120, limit: 1000, unit: "credits" });
    expect(report?.limits[0]?.window?.id).toBe("billing-period");
    expect(fetchKiroUsage).toHaveBeenCalledWith(
      expect.objectContaining({ access: "access-token", region: "us-east-1", authMethod: "idc", expires: 50 }),
    );
  });

  it("sends an API key as the ksk_ bearer", async () => {
    vi.mocked(fetchKiroUsage).mockResolvedValue(usage({ usageBuckets: [] }));
    await kiroUsageProvider.fetchUsage({ provider: "kiro", credential: { type: "api_key", apiKey: "ksk_test" } }, ctx);
    expect(fetchKiroUsage).toHaveBeenCalledWith(
      expect.objectContaining({ access: "ksk_test", authMethod: "apikey", region: "us-east-1" }),
    );
  });
});

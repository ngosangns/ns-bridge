import type { QoderQuota } from "ns-qoder-core";
import { fetchQoderQuota } from "ns-qoder-core";
import { describe, expect, it, vi } from "vitest";

import { qoderUsageProvider, toQoderUsageReport } from "../src/qoder-usage.js";

vi.mock("ns-qoder-core", () => ({
  fetchQoderQuota: vi.fn(),
}));

const resetsAt = 1_800_000_000_000;

const quota = (overrides: Partial<QoderQuota> = {}): QoderQuota => ({
  planName: "Pro",
  resetsAt,
  manageUrl: "https://qoder.com/account/usage",
  buckets: [
    { id: "user", label: "Plan credits", used: 2000, limit: 2000, remaining: 0, unit: "credits" },
    { id: "addon", label: "Add-on credits", used: 809, limit: 1900, remaining: 1091, unit: "credits" },
  ],
  raw: { usageType: "credits" },
  ...overrides,
});

const ctx = { fetch };

describe("toQoderUsageReport", () => {
  it("maps credit buckets onto the panel and marks a spent plan exhausted", () => {
    const report = toQoderUsageReport("qoder", quota(), 1000);
    expect(report).toMatchObject({
      provider: "qoder",
      fetchedAt: 1000,
      notes: ["Pro"],
      metadata: { manageUrl: "https://qoder.com/account/usage" },
      raw: { usageType: "credits" },
    });
    expect(report.limits[0]).toMatchObject({
      id: "user",
      label: "Plan credits",
      status: "exhausted",
      amount: { used: 2000, limit: 2000, unit: "credits" },
      window: { id: "billing-period", label: "Billing period", resetsAt },
    });
    expect(report.limits[1]?.status).toBe("ok");
  });

  it("omits the billing window when the payload has no reset", () => {
    const report = toQoderUsageReport("qoder", quota({ resetsAt: undefined, planName: undefined }));
    expect(report.limits[0]?.window).toBeUndefined();
    expect(report.notes).toBeUndefined();
  });
});

describe("qoderUsageProvider.fetchUsage", () => {
  it("does not validate the placeholder api key and returns null without a session", async () => {
    expect(qoderUsageProvider.validatesCredentials).toBe(false);
    vi.mocked(fetchQoderQuota).mockResolvedValue(null);
    await expect(
      qoderUsageProvider.fetchUsage({ provider: "qoder", credential: { type: "api_key", apiKey: "qoder-cli" } }, ctx),
    ).resolves.toBeNull();
    expect(fetchQoderQuota).toHaveBeenCalledWith({ fetchImpl: fetch });
  });

  it("projects the core quota for the provider OMP asked about", async () => {
    vi.mocked(fetchQoderQuota).mockResolvedValue(quota());
    const report = await qoderUsageProvider.fetchUsage(
      { provider: "qoder", credential: { type: "api_key", apiKey: "qoder-cli" } },
      ctx,
    );
    expect(report?.provider).toBe("qoder");
    expect(report?.limits).toHaveLength(2);
  });
});

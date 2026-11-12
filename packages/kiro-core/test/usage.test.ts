import { afterEach, describe, expect, it, vi } from "vitest";
import { resetKiroProfileArnCache } from "../src/management.js";
import { fetchKiroUsage, type KiroUsageUnit } from "../src/usage.js";

const creds = {
  access: "access-token",
  refresh: "refresh-token|client|secret|idc",
  expires: Date.now() + 60_000,
  clientId: "client",
  clientSecret: "secret",
  region: "us-east-1",
  authMethod: "idc" as const,
};

const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";

/** The wire object a test may rewrite before the core reads it. */
type WireUsage = {
  [key: string]: unknown;
  usageBreakdown?: Record<string, unknown>;
  usageBreakdownList?: Record<string, unknown>[];
};

function usageResponse(): WireUsage {
  return {
    nextDateReset: 1775001600,
    daysUntilReset: 6,
    subscriptionInfo: {
      subscriptionTitle: "KIRO FREE",
      subscriptionManagementTarget: "MANAGE",
    },
    overageConfiguration: {
      overageStatus: "DISABLED",
    },
    usageBreakdown: {
      resourceType: "CREDIT",
      displayName: "Credits",
      currentUsage: 0,
      currentUsageWithPrecision: 0,
      currentOverages: 0,
      currentOveragesWithPrecision: 0,
      usageLimit: 50,
      usageLimitWithPrecision: 50,
      unit: "CREDITS",
      overageCharges: 0,
      currency: "USD",
      freeTrialInfo: {
        currentUsage: 0,
        currentUsageWithPrecision: 0,
        usageLimit: 500,
        usageLimitWithPrecision: 500,
        freeTrialExpiry: 1774483200,
      },
    },
  };
}

function expectUsageRequest(rawUrl: string, expectedProfileArn: string): void {
  const url = new URL(rawUrl);
  expect(`${url.origin}${url.pathname}`).toBe("https://management.us-east-1.kiro.dev/Get-Usage-Limits");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    profileArn: expectedProfileArn,
    origin: "KIRO_CLI",
    resourceType: "CREDIT",
    isEmailRequired: "false",
  });
}

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("fetchKiroUsage", () => {
  it("uses the management GetUsageLimits contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(usageResponse()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchKiroUsage({ ...creds, profileArn });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expectUsageRequest(url, profileArn);
    expect(request.method).toBe("GET");
    expect(request.headers.Authorization).toBe("Bearer access-token");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(request.body).toBeUndefined();
  });

  it("maps the management response into OAuth provider usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(usageResponse()),
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchKiroUsage({ ...creds, profileArn });

    expect(usage).toMatchObject({
      summary: "KIRO FREE",
      subscriptionTitle: "KIRO FREE",
      daysUntilReset: 6,
      overageStatus: "DISABLED",
      manageUrl: "https://app.kiro.dev/account/usage",
      resetAt: "2026-04-01T00:00:00.000Z",
      resetAtMs: 1775001600000,
    });
    expect(usage.usageBuckets?.[0]).toMatchObject({
      label: "Credits",
      usedDisplay: "0",
      limitDisplay: "50",
      unit: "CREDITS",
      unitKind: "credits",
      bonus: {
        label: "Bonus credits",
        usedDisplay: "0",
        limitDisplay: "500",
      },
    });
  });

  async function unitKindOf(overrides: Record<string, unknown>): Promise<KiroUsageUnit | undefined> {
    const raw: WireUsage = usageResponse();
    raw.usageBreakdown = { ...raw.usageBreakdown, ...overrides };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(raw) }));
    const usage = await fetchKiroUsage({ ...creds, profileArn });
    return usage.usageBuckets?.[0]?.unitKind;
  }

  it("normalizes the units Kiro names on the wire", async () => {
    expect(await unitKindOf({ unit: "INVOCATIONS" })).toBe("credits");
    expect(await unitKindOf({ unit: undefined })).toBe("credits");
    expect(await unitKindOf({ unit: "REQUESTS" })).toBe("requests");
    expect(await unitKindOf({ unit: "TOKENS" })).toBe("tokens");
    expect(await unitKindOf({ unit: "USD" })).toBe("usd");
    expect(await unitKindOf({ unit: "widget" })).toBe("unknown");
    expect(await unitKindOf({ unit: undefined, resourceType: "SEAT" })).toBe("unknown");
  });

  it("maps every bucket in a usageBreakdownList", async () => {
    const raw: WireUsage = usageResponse();
    const credits = { ...raw.usageBreakdown };
    delete raw.usageBreakdown;
    raw.usageBreakdownList = [
      credits,
      { resourceType: "SEAT", displayName: "Seats", currentUsage: 1, usageLimit: 3, unit: "COUNT" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(raw) }));

    const usage = await fetchKiroUsage({ ...creds, profileArn });

    expect(usage.usageBuckets?.map((bucket) => [bucket.label, bucket.unitKind])).toEqual([
      ["Credits", "credits"],
      ["Seats", "unknown"],
    ]);
  });

  it("resolves a profile before fetching usage when the credential has no profile ARN", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(usageResponse()),
      });
    vi.stubGlobal("fetch", fetchMock);

    await fetchKiroUsage(creds);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1].headers["X-Amz-Target"]).toBeUndefined();
    expectUsageRequest(fetchMock.mock.calls[1][0], profileArn);
  });

  it("surfaces profile resolution failures before requesting usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage(creds)).rejects.toThrow(
      "Kiro management ListAvailableProfiles failed in us-east-1: 503 Service Unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces usage failures without another profile lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage({ ...creds, profileArn })).rejects.toThrow(
      "Kiro management GetUsageLimits failed in us-east-1: 503 Service Unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expectUsageRequest(fetchMock.mock.calls[0][0], profileArn);
  });
});

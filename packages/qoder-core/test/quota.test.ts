import { describe, expect, it } from "vitest";
import { QoderApiError, QoderAuthError } from "../src/errors.js";
import { fetchQoderQuota, parseQoderQuota } from "../src/quota.js";

const EXPIRES_AT = 1_800_000_000_000;

const personalUsage = {
  userType: "personal_professional",
  userId: "should-not-leak",
  usageType: "credits",
  expiresAt: EXPIRES_AT,
  upgradeUrl: "https://qoder.com/pricing?client=qoder",
  userQuota: { total: 2000, used: 2000, remaining: 0, percentage: 1, unit: "credits" },
  addOnQuota: {
    total: 1900,
    used: 809,
    remaining: 1091,
    percentage: 0.43,
    unit: "credits",
    detailUrl: "https://qoder.com/account/usage",
  },
  orgResourcePackage: { total: 0, used: 0, remaining: 0 },
};

describe("parseQoderQuota", () => {
  it("keeps plan and add-on credits and drops a zero-total placeholder", () => {
    const quota = parseQoderQuota(personalUsage, { plan_tier_name: "Pro", user_id: "should-not-leak" });
    expect(quota).toMatchObject({
      planName: "Pro",
      resetsAt: EXPIRES_AT,
      manageUrl: "https://qoder.com/account/usage",
      buckets: [
        { id: "user", label: "Plan credits", used: 2000, limit: 2000, remaining: 0, unit: "credits" },
        { id: "addon", label: "Add-on credits", used: 809, limit: 1900, remaining: 1091, unit: "credits" },
      ],
    });
    expect(JSON.stringify(quota?.raw)).not.toContain("should-not-leak");
  });

  it("reads an enterprise package that names cap instead of total", () => {
    const quota = parseQoderQuota({
      refreshAt: 1_700_000_000_000,
      orgResourcePackage: { cap: 100, used: 100, remaining: 0 },
    });
    expect(quota).toMatchObject({
      resetsAt: 1_700_000_000_000,
      buckets: [{ id: "org", label: "Organization credits", used: 100, limit: 100, remaining: 0 }],
    });
    expect(quota).not.toHaveProperty("planName");
  });

  it("returns null for a payload that is not an object", () => {
    expect(parseQoderQuota(null)).toBeNull();
    expect(parseQoderQuota("nope")).toBeNull();
  });
});

describe("fetchQoderQuota", () => {
  it("loads usage and plan with the bearer token and keeps buckets when the plan call fails", async () => {
    const calls: { url: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? "" });
      if (String(input).endsWith("/api/v2/user/plan")) return new Response("no", { status: 500 });
      return new Response(JSON.stringify(personalUsage), { status: 200 });
    };
    const quota = await fetchQoderQuota({ token: "test-token", fetchImpl });
    expect(calls.map((call) => call.url)).toEqual([
      "https://center.qoder.sh/api/v2/quota/usage",
      "https://center.qoder.sh/api/v2/user/plan",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer test-token")).toBe(true);
    expect(quota?.buckets.map((bucket) => bucket.id)).toEqual(["user", "addon"]);
    expect(quota).not.toHaveProperty("planName");
  });

  it("throws on 401 without the response body", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ userId: "should-not-leak" }), { status: 401 });
    await expect(fetchQoderQuota({ token: "test-token", fetchImpl })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof QoderAuthError && /HTTP 401/.test(error.message) && !error.message.includes("should-not-leak"),
    );
  });

  it("returns null without calling the network when no session was resolved", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    await expect(fetchQoderQuota({ token: null, fetchImpl })).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("reports a non-auth failure as an API error with the status only", async () => {
    const fetchImpl = async () => new Response("secret-body", { status: 502 });
    await expect(fetchQoderQuota({ token: "test-token", fetchImpl })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof QoderApiError && error.message.includes("HTTP 502") && !error.message.includes("secret-body"),
    );
  });
});

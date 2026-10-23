import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listKiroProfiles, resetKiroProfileArnCache, resolveKiroProfileArn } from "../src/management.js";
import {
  getCachedModels,
  hasCachedKiroProfileCatalog,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  updateKiroModelsCache,
} from "../src/models.js";
import {
  getKiroProfileOverride,
  KIRO_PROFILE_SELECTION_PATH,
  readKiroProfileSelection,
  writeKiroProfileSelection,
} from "../src/profile.js";

const usArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/US";
const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU";
const auth = { accessToken: "test-access-token", region: "us-east-1" };

afterEach(() => {
  rmSync(KIRO_PROFILE_SELECTION_PATH, { force: true });
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  delete process.env.KIRO_PROFILE_ARN;
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

function catalogResponse(modelIds: string[]) {
  return { ok: true, json: () => Promise.resolve({ models: modelIds.map((modelId) => ({ modelId })) }) };
}

describe("the saved profile pin", () => {
  it("round-trips and is removed by writing undefined", () => {
    expect(readKiroProfileSelection()).toBeUndefined();
    writeKiroProfileSelection({ arn: euArn, name: "KiroProfile-eu-central-1" });
    expect(readKiroProfileSelection()).toEqual({ arn: euArn, name: "KiroProfile-eu-central-1" });
    expect(getKiroProfileOverride()).toEqual({ arn: euArn, source: "ns-bridge" });
    writeKiroProfileSelection(undefined);
    expect(readKiroProfileSelection()).toBeUndefined();
  });

  it("ranks below KIRO_PROFILE_ARN", () => {
    writeKiroProfileSelection({ arn: euArn });
    process.env.KIRO_PROFILE_ARN = usArn;
    expect(getKiroProfileOverride()).toEqual({ arn: usArn, source: "env" });
  });

  it("outranks the profile a login carries, with no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    writeKiroProfileSelection({ arn: euArn });
    await expect(resolveKiroProfileArn(auth, usArn)).resolves.toBe(euArn);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listKiroProfiles", () => {
  it("collects every canonical region's profiles and skips a region that refuses", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("us-east-1")) {
        return {
          ok: true,
          json: () => Promise.resolve({ profiles: [{ arn: usArn, profileName: "KiroProfile-us-east-1" }] }),
        };
      }
      if (url.includes("eu-central-1")) {
        return {
          ok: true,
          json: () => Promise.resolve({ profiles: [{ arn: euArn, profileName: "KiroProfile-eu-central-1" }] }),
        };
      }
      return { ok: false, status: 403, statusText: "Forbidden" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const profiles = await listKiroProfiles({ accessToken: "test-access-token", region: "ap-southeast-1" });

    expect(profiles).toEqual([
      { arn: usArn, name: "KiroProfile-us-east-1", region: "us-east-1" },
      { arn: euArn, name: "KiroProfile-eu-central-1", region: "eu-central-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("the catalog cache per profile", () => {
  it("keeps the login's catalog and each pinned profile's apart", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(catalogResponse(["claude-sonnet-4.5"]))
      .mockResolvedValueOnce(catalogResponse(["claude-opus-4.6", "claude-sonnet-4.5"]));
    vi.stubGlobal("fetch", fetchMock);

    await updateKiroModelsCache(auth.accessToken, auth.region, usArn);
    writeKiroProfileSelection({ arn: euArn });
    expect(hasCachedKiroProfileCatalog(euArn)).toBe(false);
    expect(isCacheStale(auth.region)).toBe(true);
    // Until the pinned profile has a catalog, the login's stands in.
    expect(getCachedModels(auth.region).map((model) => model.id)).toEqual(["claude-sonnet-4-5"]);

    await updateKiroModelsCache(auth.accessToken, auth.region, usArn);
    expect(fetchMock.mock.calls[1][0]).toContain("https://management.eu-central-1.kiro.dev/List-Available-Models?");
    expect(hasCachedKiroProfileCatalog(euArn)).toBe(true);
    expect(isCacheStale(auth.region)).toBe(false);
    expect(getCachedModels(auth.region).map((model) => model.id)).toEqual(["claude-opus-4-6", "claude-sonnet-4-5"]);

    // Dropping the pin falls back to the login's own catalog without a fetch.
    writeKiroProfileSelection(undefined);
    expect(getCachedModels(auth.region).map((model) => model.id)).toEqual(["claude-sonnet-4-5"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const serialized = readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8");
    expect(serialized).not.toContain(usArn);
    expect(serialized).not.toContain(euArn);
    expect(serialized).not.toContain("123456789012");
  });
});

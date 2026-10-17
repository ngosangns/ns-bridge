import { afterEach, describe, expect, it, vi } from "vitest";
import type { KiroCredentials } from "../src/oauth.js";
import { refreshKiroToken, resolveKiroAuthSource, resolveKiroCredentials } from "../src/oauth.js";

// Store selection and the network refresh run in the Go sidecar. These tests
// cover the facade: which op is called, and that a refreshed session still
// schedules the in-process catalog refresh.
const runKiroOp = vi.fn<(op: string, request: () => Record<string, unknown>) => Promise<unknown>>();
vi.mock("../src/engine-ops.js", () => ({
  runKiroOp: (op: string, request: () => Record<string, unknown>) => runKiroOp(op, request),
}));

afterEach(() => {
  runKiroOp.mockReset();
  delete process.env.KIRO_AUTH_SOURCE;
  vi.unstubAllGlobals();
});

const refreshed: KiroCredentials = {
  refresh: "new_rt|cid|csec|idc",
  access: "new_at",
  expires: Date.now() + 3_600_000,
  clientId: "cid",
  clientSecret: "csec",
  region: "us-east-1",
  authMethod: "idc",
};

describe("refreshKiroToken", () => {
  it("forwards the session to refreshSession and returns the result", async () => {
    runKiroOp.mockResolvedValueOnce(refreshed);
    const input: KiroCredentials = { ...refreshed, access: "old_at", refresh: "old_rt|cid|csec|idc" };

    const creds = await refreshKiroToken(input);

    expect(creds).toEqual(refreshed);
    expect(runKiroOp).toHaveBeenCalledWith("refreshSession", expect.any(Function));
    expect(runKiroOp.mock.calls[0]?.[1]()).toEqual({ credentials: input });
  });

  it("propagates a refresh failure", async () => {
    runKiroOp.mockRejectedValueOnce(new Error("Token refresh failed: 401"));
    await expect(
      refreshKiroToken({
        refresh: "rt|c|s|idc",
        access: "x",
        expires: 0,
        clientId: "",
        clientSecret: "",
        region: "us-east-1",
        authMethod: "idc",
      }),
    ).rejects.toThrow("Token refresh failed: 401");
  });
});

describe("resolveKiroCredentials", () => {
  it("returns the session the resolveCredentials op selected", async () => {
    runKiroOp.mockResolvedValueOnce(refreshed);
    expect(await resolveKiroCredentials()).toEqual(refreshed);
    expect(runKiroOp).toHaveBeenCalledWith("resolveCredentials", expect.any(Function));
    expect(runKiroOp.mock.calls[0]?.[1]()).toEqual({});
  });

  it("returns undefined when the machine has no session", async () => {
    runKiroOp.mockResolvedValueOnce(null);
    expect(await resolveKiroCredentials()).toBeUndefined();
  });

  it("strips the catalog-refresh mark from the credentials it returns", async () => {
    runKiroOp.mockResolvedValueOnce({ ...refreshed, kiroSessionRefreshed: true });
    expect(await resolveKiroCredentials()).toEqual(refreshed);
  });
});

describe("resolveKiroAuthSource", () => {
  it("defaults to cli and warns once on an unrecognized value", () => {
    expect(resolveKiroAuthSource()).toBe("cli");
    process.env.KIRO_AUTH_SOURCE = "oidc";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveKiroAuthSource()).toBe("cli");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("accepts ide", () => {
    process.env.KIRO_AUTH_SOURCE = "IDE";
    expect(resolveKiroAuthSource()).toBe("ide");
  });
});

describe("loginKiroWithApiKey", () => {
  it("validates Kiro API key format", async () => {
    const { loginKiroWithApiKey } = await import("../src/oauth.js");
    await expect(loginKiroWithApiKey("invalid_key")).rejects.toThrow("Invalid API key format");
  });
});

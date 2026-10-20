import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinCredentials } from "ns-devin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const wrap = (name: keyof typeof child) => {
    child[name].mockImplementation((...args: unknown[]) => (actual[name] as (...inner: unknown[]) => unknown)(...args));
  };
  wrap("execFile");
  wrap("execFileSync");
  wrap("execSync");
  wrap("spawn");
  wrap("spawnSync");
  return { ...actual, ...child };
});

import { createDevinAdapter } from "../src/adapter.js";
import { apply } from "../src/index.js";

const previous = process.env.NS_DEVIN_MODEL_CACHE;
const previousRefresh = process.env.NS_BRIDGE_BACKGROUND_REFRESH;

afterEach(() => {
  if (previous === undefined) delete process.env.NS_DEVIN_MODEL_CACHE;
  else process.env.NS_DEVIN_MODEL_CACHE = previous;
  if (previousRefresh === undefined) delete process.env.NS_BRIDGE_BACKGROUND_REFRESH;
  else process.env.NS_BRIDGE_BACKGROUND_REFRESH = previousRefresh;
});

function hangingCredentials(): () => Promise<DevinCredentials> {
  return () => new Promise(() => {});
}

describe("Devin catalog refresh does not block the harness", () => {
  it("does not refresh the catalog from listModels", async () => {
    process.env.NS_BRIDGE_BACKGROUND_REFRESH = "1";
    process.env.NS_DEVIN_MODEL_CACHE = join(mkdtempSync(join(tmpdir(), "ns-dsh-devin-")), "missing.json");
    const credentials = vi.fn(hangingCredentials());
    const adapter = createDevinAdapter({
      provider: "devin",
      displayName: "Devin",
      credentials,
    });
    await adapter.listModels("devin");
    await adapter.resolveModel("devin", "swe-1-6");
    expect(credentials).not.toHaveBeenCalled();
  });

  it("lists and resolves a cached model while discovery is still pending", async () => {
    process.env.NS_DEVIN_MODEL_CACHE = join(mkdtempSync(join(tmpdir(), "ns-dsh-devin-")), "missing.json");
    const adapter = createDevinAdapter({
      provider: "devin",
      displayName: "Devin",
      credentials: hangingCredentials(),
    });

    const listed = await Promise.race([
      adapter.listModels("devin"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("listModels waited")), 50)),
    ]);
    expect(listed.map((model) => model.id)).toContain("swe-1-6");

    const resolved = await Promise.race([
      adapter.resolveModel("devin", "swe-1-6"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resolveModel waited")), 50)),
    ]);
    expect(resolved.id).toBe("swe-1-6");
    // swe-1-6's catalog ceiling is 128k of a 200k window. Reserving all of it
    // leaves the Harness compacting near 6k tokens. The reservation drops to
    // Pi's 16,384; the wire request still uses the catalog ceiling, because
    // this adapter never forwards the reservation.
    expect(resolved.context?.contextWindow).toBe(200_000);
    expect(resolved.defaultMaxTokens).toBe(16_384);
    expect(child.execFile).not.toHaveBeenCalled();
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.execSync).not.toHaveBeenCalled();
    expect(child.spawn).not.toHaveBeenCalled();
    expect(child.spawnSync).not.toHaveBeenCalled();
  });

  it("does not call the network from apply", () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      apply(
        {
          inject(_names: string[], fn: (scope: { attachments: undefined; effect: () => void }) => void) {
            fn({ attachments: undefined, effect() {} });
          },
          llm: { registerAdapter() {} },
        } as never,
        { provider: "devin", displayName: "Devin" },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(child.execFile).not.toHaveBeenCalled();
      expect(child.spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an unknown id without refreshing the catalog", async () => {
    process.env.NS_DEVIN_MODEL_CACHE = join(mkdtempSync(join(tmpdir(), "ns-dsh-devin-")), "missing.json");
    const credentials = vi.fn(async () => {
      throw new Error("no session");
    });
    const adapter = createDevinAdapter({
      provider: "devin",
      displayName: "Devin",
      credentials,
    });
    await expect(adapter.resolveModel("devin", "not-a-real-model")).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(credentials).not.toHaveBeenCalled();
  });
});

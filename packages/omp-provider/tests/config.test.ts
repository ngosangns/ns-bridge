import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OMP_NATIVE_PROVIDERS, resolveProviderSelection, shouldRegisterKiro } from "../src/config.js";

describe("resolveProviderSelection", () => {
  const missing = join(tmpdir(), "ns-omp-selection-missing", "providers.json");

  it("returns kiro, arnict, and qoder: OMP ships devin and xai itself", () => {
    expect(OMP_NATIVE_PROVIDERS).toEqual(["devin", "grok"]);
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing })).toEqual({
      kiro: true,
      arnict: true,
      qoder: true,
    });
    expect(
      Object.keys(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro,devin,grok" })),
    ).toEqual(["kiro", "arnict", "qoder"]);
  });

  it("keeps an env enable on top of the default", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: " Kiro " })).toEqual({
      kiro: true,
      arnict: true,
      qoder: true,
    });
  });

  it("uses the allow-list as the whole set", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro" })).toEqual({
      kiro: true,
      arnict: false,
      qoder: false,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "devin, grok" })).toEqual({
      kiro: false,
      arnict: false,
      qoder: false,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "arnict" })).toEqual({
      kiro: false,
      arnict: true,
      qoder: false,
    });
    expect(
      resolveProviderSelection({
        NS_BRIDGE_PROVIDERS: missing,
        NS_OMP_PROVIDERS: "devin",
        NS_OMP_PROVIDER_ENABLE: "kiro",
      }),
    ).toEqual({ kiro: true, arnict: false, qoder: false });
  });

  it("applies the deny-list last, and devin or grok in it change nothing", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({
      kiro: false,
      arnict: true,
      qoder: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "devin,grok" })).toEqual({
      kiro: true,
      arnict: true,
      qoder: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "arnict" })).toEqual({
      kiro: true,
      arnict: false,
      qoder: true,
    });
    expect(
      resolveProviderSelection({
        NS_BRIDGE_PROVIDERS: missing,
        NS_OMP_PROVIDER_ENABLE: "kiro",
        NS_OMP_PROVIDER_DISABLE: "kiro",
      }),
    ).toEqual({ kiro: false, arnict: true, qoder: true });
  });

  it("reads ~/.ns-bridge/providers.json, ignores its devin and grok keys, and lets the env deny-list win", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-omp-selection-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({ kiro: true, devin: true, grok: true }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({
      kiro: true,
      arnict: true,
      qoder: true,
    });
    writeFileSync(file, JSON.stringify({ kiro: false, devin: true, grok: true }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({
      kiro: false,
      arnict: true,
      qoder: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({
      kiro: true,
      arnict: true,
      qoder: true,
    });
    writeFileSync(file, JSON.stringify({ kiro: true, devin: false, grok: false }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({
      kiro: false,
      arnict: true,
      qoder: true,
    });
    writeFileSync(file, JSON.stringify({ arnict: false }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({
      kiro: true,
      arnict: false,
      qoder: true,
    });
  });
});

describe("shouldRegisterKiro", () => {
  const setup = (selection?: object) => {
    const home = mkdtempSync(join(tmpdir(), "ns-omp-home-"));
    const file = join(home, ".ns-bridge", "providers.json");
    if (selection) {
      mkdirSync(join(home, ".ns-bridge"), { recursive: true });
      writeFileSync(file, JSON.stringify(selection));
    }
    const installDedicated = (root = join(home, ".omp")) =>
      mkdirSync(join(root, "plugins", "node_modules", "ns-omp-provider-kiro"), { recursive: true });
    return { home, env: { NS_BRIDGE_PROVIDERS: file } as NodeJS.ProcessEnv, installDedicated };
  };

  it("registers kiro when ns-omp-provider-kiro is not installed", () => {
    const { home, env } = setup();
    expect(shouldRegisterKiro(env, home)).toBe(true);
  });

  it("defers to ns-omp-provider-kiro even when the file or env names kiro", () => {
    const { home, env, installDedicated } = setup({ kiro: true, devin: false, grok: true });
    installDedicated();
    expect(shouldRegisterKiro(env, home)).toBe(false);
    expect(shouldRegisterKiro({ ...env, NS_OMP_PROVIDERS: "kiro" }, home)).toBe(false);
  });

  it("looks for the dedicated plugin under the active OMP profile", () => {
    const { home, env, installDedicated } = setup();
    installDedicated(join(home, ".omp", "profiles", "work"));
    expect(shouldRegisterKiro(env, home)).toBe(true);
    expect(shouldRegisterKiro({ ...env, OMP_PROFILE: "work" }, home)).toBe(false);
  });

  it("still honours a kiro disable when the dedicated plugin is absent", () => {
    const { home, env } = setup({ kiro: false });
    expect(shouldRegisterKiro(env, home)).toBe(false);
  });
});

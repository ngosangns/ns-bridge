import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveProviderSelection } from "../src/config.js";

describe("resolveProviderSelection", () => {
  const missing = join(tmpdir(), "ns-omp-selection-missing", "providers.json");

  it("enables kiro, devin, and grok when no file exists", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing })).toEqual({ kiro: true, devin: true, grok: true });
  });

  it("keeps an env enable on top of the default", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({
      kiro: true,
      devin: true,
      grok: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: " Kiro " })).toEqual({
      kiro: true,
      devin: true,
      grok: true,
    });
  });

  it("uses the allow-list as the whole set", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro" })).toEqual({
      kiro: true,
      devin: false,
      grok: false,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro,devin,grok" })).toEqual({
      kiro: true,
      devin: true,
      grok: true,
    });
  });

  it("applies the deny-list last", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({
      kiro: false,
      devin: true,
      grok: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "grok" })).toEqual({
      kiro: true,
      devin: true,
      grok: false,
    });
    expect(
      resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: "kiro", NS_OMP_PROVIDER_DISABLE: "kiro" }),
    ).toEqual({ kiro: false, devin: true, grok: true });
  });

  it("supports an allow-list, with enable and deny applied after it", () => {
    const missing = join(tmpdir(), "ns-omp-selection-missing", "providers.json");
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "Devin, grok" })).toEqual({
      kiro: false,
      devin: true,
      grok: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "devin", NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({
      kiro: true,
      devin: true,
      grok: false,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "devin grok", NS_OMP_PROVIDER_DISABLE: "grok" })).toEqual({
      kiro: false,
      devin: true,
      grok: false,
    });
  });

  it("reads ~/.ns-bridge/providers.json and lets the env deny-list win", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-omp-selection-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({ kiro: true, devin: false, grok: true }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({ kiro: true, devin: false, grok: true });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({
      kiro: false,
      devin: false,
      grok: true,
    });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDERS: "devin" })).toEqual({
      kiro: false,
      devin: true,
      grok: false,
    });
  });
});

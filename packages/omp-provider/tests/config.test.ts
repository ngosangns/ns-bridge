import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OMP_NATIVE_PROVIDERS, resolveProviderSelection } from "../src/config.js";

describe("resolveProviderSelection", () => {
  const missing = join(tmpdir(), "ns-omp-selection-missing", "providers.json");

  it("only ever returns kiro: OMP ships devin and xai itself", () => {
    expect(OMP_NATIVE_PROVIDERS).toEqual(["devin", "grok"]);
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing })).toEqual({ kiro: true });
    expect(Object.keys(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro,devin,grok" }))).toEqual([
      "kiro",
    ]);
  });

  it("keeps an env enable on top of the default", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: " Kiro " })).toEqual({ kiro: true });
  });

  it("uses the allow-list as the whole set", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "kiro" })).toEqual({ kiro: true });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "devin, grok" })).toEqual({ kiro: false });
    expect(
      resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDERS: "devin", NS_OMP_PROVIDER_ENABLE: "kiro" }),
    ).toEqual({ kiro: true });
  });

  it("applies the deny-list last, and devin or grok in it change nothing", () => {
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({ kiro: false });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_DISABLE: "devin,grok" })).toEqual({ kiro: true });
    expect(
      resolveProviderSelection({ NS_BRIDGE_PROVIDERS: missing, NS_OMP_PROVIDER_ENABLE: "kiro", NS_OMP_PROVIDER_DISABLE: "kiro" }),
    ).toEqual({ kiro: false });
  });

  it("reads ~/.ns-bridge/providers.json, ignores its devin and grok keys, and lets the env deny-list win", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-omp-selection-"));
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({ kiro: true, devin: true, grok: true }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({ kiro: true });
    writeFileSync(file, JSON.stringify({ kiro: false, devin: true, grok: true }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file })).toEqual({ kiro: false });
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({ kiro: true });
    writeFileSync(file, JSON.stringify({ kiro: true, devin: false, grok: false }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file, NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({ kiro: false });
  });
});

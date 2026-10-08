import { describe, expect, it } from "vitest";

import { resolveProviderSelection } from "../src/config.js";

describe("resolveProviderSelection", () => {
  it("enables devin and grok by default; kiro is opt-in", () => {
    expect(resolveProviderSelection({})).toEqual({ kiro: false, devin: true, grok: true });
  });

  it("opts kiro in via NS_OMP_PROVIDER_ENABLE", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({ kiro: true, devin: true, grok: true });
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_ENABLE: " Kiro " })).toEqual({ kiro: true, devin: true, grok: true });
  });

  it("opts kiro in when the allow-list names it", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "kiro" })).toEqual({ kiro: true, devin: false, grok: false });
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "kiro,devin,grok" })).toEqual({ kiro: true, devin: true, grok: true });
  });

  it("supports a deny-list, applied last", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({ kiro: false, devin: true, grok: true });
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_DISABLE: "grok" })).toEqual({ kiro: false, devin: true, grok: false });
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_ENABLE: "kiro", NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({
      kiro: false,
      devin: true,
      grok: true,
    });
  });

  it("supports an allow-list, with enable and deny applied after it", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "Devin, grok" })).toEqual({ kiro: false, devin: true, grok: true });
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "devin", NS_OMP_PROVIDER_ENABLE: "kiro" })).toEqual({
      kiro: true,
      devin: true,
      grok: false,
    });
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "devin grok", NS_OMP_PROVIDER_DISABLE: "grok" })).toEqual({
      kiro: false,
      devin: true,
      grok: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import { resolveProviderSelection } from "../src/config.js";

describe("resolveProviderSelection", () => {
  it("enables everything by default", () => {
    expect(resolveProviderSelection({})).toEqual({ kiro: true, devin: true, grok: true });
  });

  it("supports a deny-list", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDER_DISABLE: "kiro" })).toEqual({ kiro: false, devin: true, grok: true });
  });

  it("supports an allow-list, with deny applied after it", () => {
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "Devin, grok" })).toEqual({ kiro: false, devin: true, grok: true });
    expect(resolveProviderSelection({ NS_OMP_PROVIDERS: "devin grok", NS_OMP_PROVIDER_DISABLE: "grok" })).toEqual({
      kiro: false,
      devin: true,
      grok: false,
    });
  });
});

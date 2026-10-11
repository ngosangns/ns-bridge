// ABOUTME: The OIDC endpoint kiro-core re-exports is the same host the Go
// ABOUTME: vendor refreshes tokens against (a {region} template there). Drift
// ABOUTME: means the facade and the binary disagree — pin both sides.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SSO_OIDC_ENDPOINT } from "../src/oauth.js";

const goSource = (file: string) => readFileSync(new URL(`../../../go/${file}`, import.meta.url), "utf8");

describe("kiro constants parity with the Go vendor", () => {
  it("keeps the SSO OIDC endpoint in lockstep", () => {
    const template = SSO_OIDC_ENDPOINT.replace("us-east-1", "{region}");
    const ops = goSource("internal/vendors/kiro/ops.go");
    const pattern = new RegExp(`defaultOIDCEndpoint\\s*=\\s*"${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    expect(pattern.test(ops)).toBe(true);
  });
});

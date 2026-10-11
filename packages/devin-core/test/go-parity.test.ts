// ABOUTME: The constants devin-core re-exports also live inside the Go vendor
// ABOUTME: (login endpoints, session-token framing). Drift means the facade and
// ABOUTME: the binary disagree on where Devin lives — these assertions pin both sides.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_MANAGEMENT_BASE_URL,
  DEVIN_SESSION_TOKEN_PREFIX,
  DEVIN_WEBAPP_URL,
} from "../src/wire.js";

const goSource = (file: string) => readFileSync(new URL(`../../../go/${file}`, import.meta.url), "utf8");

/** True when the Go file declares `name = "<value>"` (any alignment gofmt picks). */
function declares(source: string, name: string, value: string): boolean {
  const pattern = new RegExp(`${name}\\s*=\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  return pattern.test(source);
}

describe("devin constants parity with the Go vendor", () => {
  it("keeps the Cascade base URL in lockstep", () => {
    expect(declares(goSource("internal/vendors/devin/wire.go"), "DefaultBaseURL", DEVIN_DEFAULT_BASE_URL)).toBe(true);
  });

  it("keeps the session token prefix in lockstep", () => {
    expect(declares(goSource("internal/vendors/devin/wire.go"), "SessionTokenPrefix", DEVIN_SESSION_TOKEN_PREFIX)).toBe(
      true,
    );
  });

  it("keeps the login endpoints in lockstep", () => {
    const login = goSource("internal/vendors/devin/login.go");
    expect(declares(login, "loginWebappURL", DEVIN_WEBAPP_URL)).toBe(true);
    expect(declares(login, "loginManagementURL", DEVIN_MANAGEMENT_BASE_URL)).toBe(true);
  });
});

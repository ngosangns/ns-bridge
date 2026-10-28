import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qodercliSessionPresent, resolveQoderAuth } from "../src/auth.js";

describe("resolveQoderAuth", () => {
  it("is absent when the qodercli session directory is empty", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    const env = { QODER_CONFIG_DIR: home };
    expect(qodercliSessionPresent(env)).toBe(false);
    expect(resolveQoderAuth(env)).toBeUndefined();
  });

  it("uses qodercli only after a session file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    mkdirSync(join(home, ".auth"));
    writeFileSync(join(home, ".auth", "session.json"), "{}");
    const env = { QODER_CONFIG_DIR: home };
    expect(qodercliSessionPresent(env)).toBe(true);
    expect(resolveQoderAuth(env)?.mode).toBe("qodercli");
  });

  it("prefers a PAT over a missing session", () => {
    const env = {
      QODER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "qoder-auth-")),
      QODER_PERSONAL_ACCESS_TOKEN: "pat-test",
    };
    expect(resolveQoderAuth(env)?.mode).toBe("pat");
  });
});

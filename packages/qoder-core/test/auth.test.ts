import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qodercliSessionPresent, requireQoderAuth, resolveQoderAuth } from "../src/auth.js";
import { QoderAuthError } from "../src/errors.js";
import { encryptQoderStore } from "../src/store.js";

const MACHINE_ID = "3d3b8420-6a3c-4c11-9d1e-2f4a5b6c7d8e";

function writeStore(configDir: string, body: object): void {
  mkdirSync(join(configDir, ".auth"), { recursive: true });
  writeFileSync(join(configDir, ".auth", "machine_id"), MACHINE_ID);
  writeFileSync(join(configDir, ".auth", "user"), encryptQoderStore(JSON.stringify(body), MACHINE_ID.slice(0, 16)));
}

describe("resolveQoderAuth", () => {
  it("is absent when the qodercli session directory is empty", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    const env = { QODER_CONFIG_DIR: home };
    expect(qodercliSessionPresent(env)).toBe(false);
    expect(resolveQoderAuth(env)).toBeUndefined();
  });

  it("stays absent when the session dir has no readable store", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    mkdirSync(join(home, ".auth"));
    writeFileSync(join(home, ".auth", "session.json"), "{}");
    const env = { QODER_CONFIG_DIR: home };
    expect(qodercliSessionPresent(env)).toBe(true);
    expect(resolveQoderAuth(env)).toBeUndefined();
  });

  it("reads the token from an encrypted qodercli store", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    writeStore(home, { access_token: "a".repeat(27), security_oauth_token: "s".repeat(27) });
    const auth = resolveQoderAuth({ QODER_CONFIG_DIR: home });
    expect(auth?.mode).toBe("qodercli");
    expect(auth?.token).toBe("s".repeat(27));
  });

  it("falls back to access_token when security_oauth_token is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    writeStore(home, { access_token: "a".repeat(27) });
    expect(resolveQoderAuth({ QODER_CONFIG_DIR: home })?.token).toBe("a".repeat(27));
  });

  it("treats an undecryptable store as absent and requires login", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    mkdirSync(join(home, ".auth"));
    writeFileSync(join(home, ".auth", "machine_id"), MACHINE_ID);
    writeFileSync(join(home, ".auth", "user"), "not-a-store");
    expect(resolveQoderAuth({ QODER_CONFIG_DIR: home })).toBeUndefined();
    try {
      requireQoderAuth({ QODER_CONFIG_DIR: home });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QoderAuthError);
    }
  });

  it("is absent when the store has no token", () => {
    const home = mkdtempSync(join(tmpdir(), "qoder-auth-"));
    writeStore(home, { uid: "u" });
    expect(resolveQoderAuth({ QODER_CONFIG_DIR: home })).toBeUndefined();
    expect(() => requireQoderAuth({ QODER_CONFIG_DIR: home })).toThrow(QoderAuthError);
  });

  it("prefers a PAT over a missing session", () => {
    const env = {
      QODER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "qoder-auth-")),
      QODER_PERSONAL_ACCESS_TOKEN: "pat-test",
    };
    expect(resolveQoderAuth(env)?.mode).toBe("pat");
  });
});

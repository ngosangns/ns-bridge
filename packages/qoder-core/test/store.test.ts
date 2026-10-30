import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptQoderStore, encryptQoderStore, readQoderStore } from "../src/store.js";

const KEY = "0123456789abcdef";

describe("store wasm", () => {
  it("round-trips a payload", () => {
    const plain = JSON.stringify({ hello: "world", n: 42 });
    expect(decryptQoderStore(encryptQoderStore(plain, KEY), KEY)).toBe(plain);
  });

  it("fails with a wrong key", () => {
    expect(() => decryptQoderStore(encryptQoderStore("{}", KEY), "fedcba9876543210")).toThrow();
  });
});

describe("readQoderStore", () => {
  it("decrypts a config dir written the way qodercli writes it", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qoder-store-"));
    mkdirSync(join(configDir, ".auth"));
    const machineId = "3d3b8420-6a3c-4c11-9d1e-2f4a5b6c7d8e";
    writeFileSync(join(configDir, ".auth", "machine_id"), `${machineId}\n`);
    writeFileSync(
      join(configDir, ".auth", "user"),
      encryptQoderStore(
        JSON.stringify({
          access_token: "a".repeat(27),
          security_oauth_token: "s".repeat(27),
          refresh_token: "r".repeat(28),
          expire_time: 1795238476,
          uid: "u".repeat(36),
          email: "user@example.com",
        }),
        machineId.slice(0, 16),
      ),
    );
    const store = readQoderStore(configDir);
    expect(store.accessToken).toHaveLength(27);
    expect(store.securityOauthToken).toHaveLength(27);
    expect(store.refreshToken).toHaveLength(28);
    expect(store.expireTime).toBe(1795238476);
    expect(store.uid).toHaveLength(36);
    expect(store.email).toBe("user@example.com");
  });

  it("leaves optional fields out", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qoder-store-"));
    mkdirSync(join(configDir, ".auth"));
    writeFileSync(join(configDir, ".auth", "machine_id"), KEY);
    writeFileSync(join(configDir, ".auth", "user"), encryptQoderStore("{}", KEY));
    const store = readQoderStore(configDir);
    expect(store.accessToken).toBeUndefined();
    expect(store.expireTime).toBeUndefined();
  });
});

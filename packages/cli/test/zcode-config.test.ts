import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureZcodeServeConfig, readZcodeServeConfig, zcodeConfigPath } from "../src/zcode-config.js";

describe("zcode config", () => {
  it("creates the file once with a hex token and locked-down permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
    const path = join(dir, "nested", "zcode.json");
    try {
      const config = ensureZcodeServeConfig(path);
      expect(config.port).toBe(47821);
      expect(config.token).toMatch(/^[0-9a-f]{48}$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads back what was written", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
    const path = join(dir, "zcode.json");
    try {
      const created = ensureZcodeServeConfig(path);
      expect(readZcodeServeConfig(path)).toEqual(created);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing, broken, or incomplete file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
    const path = join(dir, "zcode.json");
    try {
      expect(readZcodeServeConfig(path)).toBeUndefined();
      writeFileSync(path, "{");
      expect(readZcodeServeConfig(path)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ port: 47821 }));
      expect(readZcodeServeConfig(path)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ token: "t" }));
      expect(readZcodeServeConfig(path)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ port: 0, token: "t" }));
      expect(readZcodeServeConfig(path)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ port: 47821, token: "" }));
      expect(readZcodeServeConfig(path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never rewrites an existing valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
    const path = join(dir, "zcode.json");
    try {
      const first = ensureZcodeServeConfig(path);
      const body = readFileSync(path, "utf8");
      const second = ensureZcodeServeConfig(path);
      expect(second).toEqual(first);
      expect(readFileSync(path, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the mode of an existing file instead of reopening it permissive", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
    const path = join(dir, "zcode.json");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify({ port: 47821, token: "existing" }), { mode: 0o600 });
      chmodSync(path, 0o400);
      expect(ensureZcodeServeConfig(path)).toEqual({ port: 47821, token: "existing" });
      expect(statSync(path).mode & 0o777).toBe(0o400);
    } finally {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours NS_BRIDGE_ZCODE_CONFIG as the default path", () => {
    expect(zcodeConfigPath({ NS_BRIDGE_ZCODE_CONFIG: "/tmp/elsewhere.json" })).toBe("/tmp/elsewhere.json");
    expect(zcodeConfigPath({})).toBe(join(homedir(), ".ns-bridge", "zcode.json"));
  });
});

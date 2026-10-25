// ABOUTME: Tests the Arnict API-key resolution and storage.
// ABOUTME: A missing, blank, unreadable, or corrupt credential is no key, never a crash.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARNICT_API_KEY_ENV,
  ARNICT_CONFIG_PATH_ENV,
  arnictConfigPath,
  clearArnictApiKey,
  loadArnictApiKey,
  maskArnictKey,
  resolveArnictApiKey,
  writeArnictApiKey,
} from "../src/auth.js";
import { ARNICT_LOGIN_MESSAGE, ArnictAuthError } from "../src/errors.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function configAt(dir: string): string {
  return join(dir, "arnict.json");
}

describe("arnictConfigPath", () => {
  it("lives under ~/.ns-bridge", () => {
    expect(arnictConfigPath("/home/dev")).toBe(join("/home/dev", ".ns-bridge", "arnict.json"));
    expect(arnictConfigPath()).toBe(join(homedir(), ".ns-bridge", "arnict.json"));
  });

  it("honors the full-path override", () => {
    expect(arnictConfigPath("/home/dev", { [ARNICT_CONFIG_PATH_ENV]: "/var/keys/arnict.json" })).toBe(
      "/var/keys/arnict.json",
    );
  });
});

describe("resolveArnictApiKey", () => {
  it("prefers the environment over the config file", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = configAt(dir);
    await writeFile(configPath, JSON.stringify({ apiKey: "sk-config" }));
    const resolved = await resolveArnictApiKey({
      env: { [ARNICT_API_KEY_ENV]: "sk-env" },
      configPath,
    });
    expect(resolved).toEqual({ apiKey: "sk-env", source: "env" });
  });

  it("reads the config file when the environment has nothing", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = configAt(dir);
    await writeFile(configPath, JSON.stringify({ apiKey: "  sk-config  " }));
    const resolved = await resolveArnictApiKey({ env: {}, configPath });
    expect(resolved).toEqual({ apiKey: "sk-config", source: "config" });
  });

  it("treats a blank env value as missing and falls through", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = configAt(dir);
    await writeFile(configPath, JSON.stringify({ apiKey: "sk-config" }));
    const resolved = await resolveArnictApiKey({
      env: { [ARNICT_API_KEY_ENV]: "   " },
      configPath,
    });
    expect(resolved).toEqual({ apiKey: "sk-config", source: "config" });
  });

  it("returns undefined for a missing file, a corrupt file, or a wrong shape", async () => {
    const dir = await tempDir("arnict-auth-");
    const corrupt = configAt(dir);
    await writeFile(corrupt, "{not json");
    const wrongShape = join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ token: "sk-nope" }));
    expect(await resolveArnictApiKey({ env: {}, configPath: join(dir, "absent.json") })).toBeUndefined();
    expect(await resolveArnictApiKey({ env: {}, configPath: corrupt })).toBeUndefined();
    expect(await resolveArnictApiKey({ env: {}, configPath: wrongShape })).toBeUndefined();
  });
});

describe("loadArnictApiKey", () => {
  it("throws the login error when no key exists", async () => {
    const dir = await tempDir("arnict-auth-");
    const error = await loadArnictApiKey({ env: {}, configPath: join(dir, "absent.json") }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ArnictAuthError);
    expect((error as ArnictAuthError).message).toBe(ARNICT_LOGIN_MESSAGE);
  });

  it("returns the resolved key when one exists", async () => {
    const loaded = await loadArnictApiKey({ env: { [ARNICT_API_KEY_ENV]: "sk-env" } });
    expect(loaded.apiKey).toBe("sk-env");
  });
});

describe("writeArnictApiKey", () => {
  it("creates the directory 0700 and the file 0600", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = join(dir, ".ns-bridge", "arnict.json");
    await writeArnictApiKey("sk-secret", { configPath });
    const fileMode = (await stat(configPath)).mode & 0o777;
    const dirMode = (await stat(join(dir, ".ns-bridge"))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ apiKey: "sk-secret" });
    expect(await resolveArnictApiKey({ env: {}, configPath })).toEqual({ apiKey: "sk-secret", source: "config" });
  });

  it("leaves no temp file behind", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = join(dir, "arnict.json");
    await writeArnictApiKey("sk-secret", { configPath });
    const entries = await readdir(dir);
    expect(entries).toEqual(["arnict.json"]);
  });
});

describe("clearArnictApiKey", () => {
  it("removes an existing file and reports a missing one", async () => {
    const dir = await tempDir("arnict-auth-");
    const configPath = configAt(dir);
    await writeArnictApiKey("sk-secret", { configPath });
    expect(await clearArnictApiKey({ configPath })).toBe(true);
    expect(await clearArnictApiKey({ configPath })).toBe(false);
  });
});

describe("maskArnictKey", () => {
  it("shows the first and last four characters", () => {
    expect(maskArnictKey("sk-arnict-0123456789")).toBe("sk-a…6789");
  });

  it("hides a short key entirely", () => {
    expect(maskArnictKey("short")).toBe("****");
    expect(maskArnictKey("12345678")).toBe("****");
  });
});

describe("directory permissions", () => {
  it("keeps an existing directory's mode instead of resetting it", async () => {
    const dir = await tempDir("arnict-auth-");
    const nested = join(dir, "already");
    await mkdir(nested, { mode: 0o755 });
    await writeArnictApiKey("sk-secret", { configPath: join(nested, "arnict.json") });
    expect((await stat(nested)).mode & 0o777).toBe(0o755);
  });
});

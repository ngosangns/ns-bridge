import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQoderModels, qoderVendorCatalogFile } from "../src/models-api.js";
import { encryptQoderStore } from "../src/store.js";

const roots: string[] = [];

function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "qoder-models-"));
  roots.push(root);
  return root;
}

function writeCatalog(dir: string, uid: string, version: number): string {
  const target = join(dir, ".models", uid);
  mkdirSync(target, { recursive: true });
  const file = join(target, `catalog-v${version}`);
  writeFileSync(file, `encrypted-${version}`);
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MACHINE_ID = "3d3b8420-6a3c-4c11-9d1e-2f4a5b6c7d8e";

function loggedInConfigDir(): string {
  const dir = configDir();
  mkdirSync(join(dir, ".auth"));
  writeFileSync(join(dir, ".auth", "machine_id"), MACHINE_ID);
  writeFileSync(
    join(dir, ".auth", "user"),
    encryptQoderStore(JSON.stringify({ uid: "u-1", security_oauth_token: "token" }), MACHINE_ID.slice(0, 16)),
  );
  vi.stubEnv("QODER_CONFIG_DIR", dir);
  return dir;
}

const SERVER_LIST = {
  assistant: [
    { key: "auto", display_name: "Auto", enable: true },
    { key: "qmodel_latest", display_name: "Qwen4-Max", enable: true, is_reasoning: true },
    { key: "hidden", display_name: "Hidden", enable: false },
  ],
};

describe("qoderVendorCatalogFile", () => {
  it("reads the uid and scene from the pointer and takes the newest catalog", () => {
    const dir = configDir();
    writeCatalog(dir, "user-1", 6);
    const newest = writeCatalog(dir, "user-1", 7);
    writeFileSync(join(dir, ".models", "default"), JSON.stringify({ uid: "user-1", scene: "assistant" }));
    expect(qoderVendorCatalogFile(dir)).toEqual({ file: newest, uid: "user-1", scene: "assistant" });
  });

  it("finds the cache without a pointer", () => {
    const dir = configDir();
    writeCatalog(dir, "user-2", 3);
    const target = qoderVendorCatalogFile(dir);
    expect(target?.uid).toBe("user-2");
    expect(target?.file.endsWith("catalog-v3")).toBe(true);
    expect(target?.scene).toBeUndefined();
  });

  it("falls back past a pointer whose cache is gone", () => {
    const dir = configDir();
    writeCatalog(dir, "old-user", 2);
    mkdirSync(join(dir, ".models", "gone"), { recursive: true });
    writeFileSync(join(dir, ".models", "default"), JSON.stringify({ uid: "gone", scene: "assistant" }));
    expect(qoderVendorCatalogFile(dir)?.uid).toBe("old-user");
  });

  it("returns undefined when the CLI never wrote a cache", () => {
    expect(qoderVendorCatalogFile(configDir())).toBeUndefined();
  });
});

describe("fetchQoderModels", () => {
  it("reads the account's models from the server and reports them as server-sourced", async () => {
    loggedInConfigDir();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify(SERVER_LIST), { status: 200 });
    });
    const list = await fetchQoderModels();
    expect(list.source).toBe("server");
    expect(list.models.map((model) => model.id)).toEqual(["auto", "qmodel_latest"]);
    expect(list.models[1]?.name).toBe("Qwen4-Max");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/algo/api/v2/model/list");
    expect(calls[0]?.headers.Authorization).toBeTruthy();
  });

  it("falls back to the bootstrap list and names the failure when the server rejects the login", async () => {
    loggedInConfigDir();
    vi.stubGlobal("fetch", async () => new Response("Login expired", { status: 403 }));
    const list = await fetchQoderModels();
    expect(list.source).toBe("bootstrap");
    expect(list.error).toContain("Login expired");
    expect(list.models.length).toBeGreaterThan(0);
  });

  it("does not call the server without a local session", async () => {
    vi.stubEnv("QODER_CONFIG_DIR", configDir());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const list = await fetchQoderModels();
    expect(list.source).toBe("bootstrap");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a server answer with no assistant models as a failure", async () => {
    loggedInConfigDir();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ assistant: [] }), { status: 200 }));
    const list = await fetchQoderModels();
    expect(list.source).toBe("bootstrap");
    expect(list.error).toContain("no models");
  });
});

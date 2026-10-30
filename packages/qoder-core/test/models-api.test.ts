import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { qoderVendorCatalogFile } from "../src/models-api.js";

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

// ABOUTME: Tests for the atomic JSON cache helpers.
// ABOUTME: The point of the helper is crash safety, so the assertions are about the target file.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFileAtomic } from "../src/cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ns-core-utils-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readJsonFile", () => {
  it("parses a JSON file", () => {
    const path = join(dir, "cache.json");
    writeFileSync(path, JSON.stringify({ fetchedAt: 1, models: [] }), "utf8");
    expect(readJsonFile(path)).toEqual({ fetchedAt: 1, models: [] });
  });

  it("returns undefined for a missing file", () => {
    expect(readJsonFile(join(dir, "absent.json"))).toBeUndefined();
  });

  it("returns undefined for malformed JSON instead of throwing", () => {
    const path = join(dir, "torn.json");
    writeFileSync(path, '{"fetchedAt": 1, "mod', "utf8");
    expect(readJsonFile(path)).toBeUndefined();
  });
});

describe("writeJsonFileAtomic", () => {
  it("writes the payload and creates missing parent directories", () => {
    const path = join(dir, "nested", "deeper", "cache.json");
    writeJsonFileAtomic(path, { fetchedAt: 7, models: [{ id: "a" }] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ fetchedAt: 7, models: [{ id: "a" }] });
  });

  it("pretty-prints when asked, matching the existing catalog style", () => {
    const path = join(dir, "pretty.json");
    writeJsonFileAtomic(path, { a: 1 }, { pretty: true });
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}');
  });

  it("leaves no temp file behind on success", () => {
    const path = join(dir, "cache.json");
    writeJsonFileAtomic(path, { ok: true });
    expect(readdirSync(dir)).toEqual(["cache.json"]);
  });

  it("overwrites an existing file in place", () => {
    const path = join(dir, "cache.json");
    writeJsonFileAtomic(path, { generation: 1 });
    writeJsonFileAtomic(path, { generation: 2 });
    expect(readJsonFile(path)).toEqual({ generation: 2 });
    expect(readdirSync(dir)).toEqual(["cache.json"]);
  });
});

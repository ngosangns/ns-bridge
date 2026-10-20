// ABOUTME: Atomic JSON cache read/write shared by the vendor model catalogs.
// ABOUTME: A crash mid-write must never leave a torn file a host then parses.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read and parse a JSON file, or `undefined` when it is absent, unreadable, or
 * not valid JSON. Callers treat `undefined` as a cache miss and fall back to
 * their bootstrap catalog.
 */
export function readJsonFile<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write JSON so a reader never observes a partial file: the payload lands in a
 * sibling temp file first and is then renamed over the target, which is atomic
 * within a filesystem.
 *
 * `pretty` matches the on-disk style the catalogs already use. A read-only home
 * directory throws; callers that must survive it catch and keep their
 * in-memory copy.
 */
export function writeJsonFileAtomic(path: string, value: unknown, options: { pretty?: boolean } = {}): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(value, null, options.pretty ? 2 : undefined), "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

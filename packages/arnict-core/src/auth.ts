// ABOUTME: Resolves the Arnict API key from the environment or the local config file.
// ABOUTME: Key values never appear in error messages or logs.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ARNICT_LOGIN_MESSAGE, ArnictAuthError } from "./errors.js";

/** Environment variable a user can export instead of storing the key on disk. */
export const ARNICT_API_KEY_ENV = "ARNICT_API_KEY";

/** Full-path override for where the config file lives; tests and sandboxed hosts use it. */
export const ARNICT_CONFIG_PATH_ENV = "NS_BRIDGE_ARNICT_CONFIG";

/**
 * Where the Arnict key is stored. An explicit `NS_BRIDGE_ARNICT_CONFIG` wins as a
 * full path; otherwise it is `<home>/.ns-bridge/arnict.json`.
 */
export function arnictConfigPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ARNICT_CONFIG_PATH_ENV]?.trim();
  if (override) return override;
  return join(home, ".ns-bridge", "arnict.json");
}

export interface ResolvedArnictApiKey {
  apiKey: string;
  source: "env" | "config";
}

export interface ResolveArnictApiKeyOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to {@link arnictConfigPath}. */
  configPath?: string;
  /** Injectable read for tests; sync or async. */
  readFile?: (path: string) => string | Promise<string>;
}

async function configApiKey(
  path: string,
  read: (file: string) => string | Promise<string>,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    const key = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The API key to call api.arnict.com with, or `undefined` when the user has none.
 *
 * `ARNICT_API_KEY` wins over the config file. A blank value is no value: a
 * whitespace key falls through to the file, and an unreadable or corrupt file
 * is simply no key, never a thrown error.
 */
export async function resolveArnictApiKey(
  options: ResolveArnictApiKeyOptions = {},
): Promise<ResolvedArnictApiKey | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[ARNICT_API_KEY_ENV]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  const path = options.configPath ?? arnictConfigPath(homedir(), env);
  const read = options.readFile ?? ((file: string) => readFile(file, "utf8"));
  const fromConfig = await configApiKey(path, read);
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  return undefined;
}

/** {@link resolveArnictApiKey}, but a missing key is the login error a CLI can show. */
export async function loadArnictApiKey(options: ResolveArnictApiKeyOptions = {}): Promise<ResolvedArnictApiKey> {
  const resolved = await resolveArnictApiKey(options);
  if (!resolved) throw new ArnictAuthError(ARNICT_LOGIN_MESSAGE);
  return resolved;
}

/**
 * Store the key as `{"apiKey": ...}` with the narrowest permissions available:
 * the `.ns-bridge` directory is created 0700 and the file lands 0600 by writing
 * a temp file and renaming it into place.
 */
export async function writeArnictApiKey(apiKey: string, options: { configPath?: string } = {}): Promise<void> {
  const path = options.configPath ?? arnictConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ apiKey: apiKey.trim() }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove the stored key. True when a file was actually deleted. */
export async function clearArnictApiKey(options: { configPath?: string } = {}): Promise<boolean> {
  const path = options.configPath ?? arnictConfigPath();
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A key safe to print: `abcd…wxyz`. A key of 8 characters or fewer would be
 * fully revealed by that shape, so it becomes `****`.
 */
export function maskArnictKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

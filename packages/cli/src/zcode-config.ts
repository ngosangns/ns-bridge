/**
 * Token and port for `ns-bridge serve`, kept in ~/.ns-bridge/zcode.json so
 * ZCode and the server agree without them passing anything on a command line.
 * The file is created once and then only read — a rewrite would silently
 * rotate the token out from under a configured client.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ZcodeServeConfig {
  port: number;
  token: string;
}

export const DEFAULT_ZCODE_PORT = 47821;

/** `NS_BRIDGE_ZCODE_CONFIG` moves the file; the default lives in ~/.ns-bridge. */
export function zcodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NS_BRIDGE_ZCODE_CONFIG?.trim();
  if (override) return override;
  return join(homedir(), ".ns-bridge", "zcode.json");
}

/** Parse the file, or undefined when it is missing, unreadable, or incomplete. */
export function readZcodeServeConfig(path: string): ZcodeServeConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { port, token } = parsed as Record<string, unknown>;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return { port, token };
}

/** Read the config, creating it first when missing or unusable. */
export function ensureZcodeServeConfig(path: string): ZcodeServeConfig {
  const existing = readZcodeServeConfig(path);
  if (existing) return existing;
  const config: ZcodeServeConfig = { port: DEFAULT_ZCODE_PORT, token: randomBytes(24).toString("hex") };
  // The directory and the file are secrets, not just their contents.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

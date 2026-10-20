// ABOUTME: Locating and probing the local Grok agent CLI binary.
// ABOUTME: Host-neutral: the env names are the CLI's own, not one host's.

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATE_NAMES = ["agent", "grok"] as const;

/**
 * Environment variables that name the binary outright, most specific first.
 *
 * `PI_GROK_SDK_BIN` and `PI_GROK_AGENT_BIN` are the Pi provider's historical
 * names and stay supported; `GROK_AGENT_BIN` and `GROK_BIN` are the neutral
 * ones a non-Pi host should set.
 */
const BINARY_ENV_NAMES = ["GROK_AGENT_BIN", "GROK_BIN", "PI_GROK_SDK_BIN", "PI_GROK_AGENT_BIN"] as const;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name: string): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && isExecutable(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the local Grok agent CLI binary.
 *
 * Order:
 * 1. `GROK_AGENT_BIN` / `GROK_BIN` / `PI_GROK_SDK_BIN` / `PI_GROK_AGENT_BIN`
 * 2. `agent` then `grok` on PATH
 * 3. `~/.grok/bin/{agent,grok}` (standard install location)
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = BINARY_ENV_NAMES.map((name) => env[name]?.trim()).find(Boolean);
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(
        `Configured Grok agent binary is not executable: ${explicit}. Check ${BINARY_ENV_NAMES.join(" / ")}.`,
      );
    }
    return explicit;
  }

  for (const name of CANDIDATE_NAMES) {
    const found = which(name);
    if (found) return found;
  }

  const homeBin = join(homedir(), ".grok", "bin");
  for (const name of CANDIDATE_NAMES) {
    const candidate = join(homeBin, name);
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Grok agent CLI not found. Install/authenticate the xAI Grok agent (`agent` or `grok` on PATH, or ~/.grok/bin). Then run: agent --version",
  );
}

/**
 * The CLI's reported version, or `"unknown"`.
 *
 * Synchronous on purpose: this is a one-shot probe on a status path, not a
 * per-turn call. A host that calls it inside a stream should not.
 */
export function getGrokVersion(binary?: string): string {
  try {
    const bin = binary ?? resolveGrokBinary();
    return execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Whether the CLI reports an authenticated session. */
export function probeGrokAuth(binary?: string): boolean {
  try {
    const bin = binary ?? resolveGrokBinary();
    const stdout = execFileSync(bin, ["models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    return !/not authenticated/i.test(stdout);
  } catch {
    return false;
  }
}

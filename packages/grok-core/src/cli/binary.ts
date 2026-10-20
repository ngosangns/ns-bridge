// ABOUTME: Locating and probing the local Grok CLI binary.
// ABOUTME: Host-neutral: the env names are the CLI's own, not one host's.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATE_NAMES = ["agent", "grok"] as const;

/** Environment variables that name the binary outright, most specific first. */
const BINARY_ENV_NAMES = ["GROK_AGENT_BIN", "GROK_BIN"] as const;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command and return its stdout, or `undefined` when it fails.
 *
 * Async on purpose. These probes spawn a process, and a synchronous spawn
 * stalls every other request the host is serving until it returns. The callers
 * are status and refresh paths, so awaiting them costs nothing.
 */
function run(command: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

async function which(name: string): Promise<string | undefined> {
  const out = await run(process.platform === "win32" ? "where" : "which", [name], 5_000);
  if (out === undefined) return undefined;
  const first = out
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first && isExecutable(first) ? first : undefined;
}

/**
 * Resolve the local Grok CLI binary.
 *
 * Order:
 * 1. `GROK_AGENT_BIN` / `GROK_BIN`
 * 2. `agent` then `grok` on PATH
 * 3. `~/.grok/bin/{agent,grok}` (standard install location)
 */
export async function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = BINARY_ENV_NAMES.map((name) => env[name]?.trim()).find(Boolean);
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`Configured Grok binary is not executable: ${explicit}. Check ${BINARY_ENV_NAMES.join(" / ")}.`);
    }
    return explicit;
  }

  for (const name of CANDIDATE_NAMES) {
    const found = await which(name);
    if (found) return found;
  }

  const homeBin = join(homedir(), ".grok", "bin");
  for (const name of CANDIDATE_NAMES) {
    const candidate = join(homeBin, name);
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Grok CLI not found. Install/authenticate the xAI Grok CLI (`agent` or `grok` on PATH, or ~/.grok/bin). Then run: agent --version",
  );
}

/** The CLI's reported version, or `"unknown"` when the binary cannot say. */
export async function getGrokVersion(binary?: string): Promise<string> {
  try {
    const bin = binary ?? (await resolveGrokBinary());
    return (await run(bin, ["--version"], 8_000))?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Whether the CLI reports an authenticated session. */
export async function probeGrokAuth(binary?: string): Promise<boolean> {
  try {
    const bin = binary ?? (await resolveGrokBinary());
    const stdout = await run(bin, ["models"], 20_000);
    return stdout !== undefined && !/not authenticated/i.test(stdout);
  } catch {
    return false;
  }
}

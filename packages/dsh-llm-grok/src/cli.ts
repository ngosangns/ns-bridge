/**
 * Arguments for one Grok CLI turn. The process is not allowed to run tools:
 * `--max-turns 1` returns the model's tool call, and `--always-approve` is
 * never set.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveCliModelId(modelId: string): string {
  if (modelId === "grok-4.5-agent") return "grok-4.5";
  if (modelId.endsWith("-agent") && modelId.length > "-agent".length) {
    return modelId.slice(0, -"-agent".length);
  }
  return modelId;
}

export function buildGrokCliArgs(options: { prompt: string; model: string; reasoningEffort?: string }): string[] {
  const prompt = options.prompt.length > 0 ? options.prompt : " ";
  const args = [
    "--single",
    prompt,
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    "--model",
    resolveCliModelId(options.model),
    "--max-turns",
    "1",
    "--no-plan",
    "--no-subagents",
  ];
  const effort = options.reasoningEffort?.trim().toLowerCase();
  if (effort && effort !== "none" && effort !== "off") {
    args.push("--reasoning-effort", effort);
  }
  return args;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichGrok(): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["grok"], {
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

/** Resolve the `grok` binary. An explicit path wins; `agent` is not a candidate. */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    env.PI_GROK_SDK_BIN?.trim() || env.PI_GROK_AGENT_BIN?.trim() || env.GROK_AGENT_BIN?.trim() || env.GROK_BIN?.trim();
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`Configured Grok binary is not executable: ${explicit}`);
    }
    return explicit;
  }
  const found = whichGrok();
  if (found) return found;
  const homeBin = join(homedir(), ".grok", "bin", "grok");
  if (isExecutable(homeBin)) return homeBin;
  throw new Error("Grok CLI not found. Install `grok` on PATH, or set GROK_BIN.");
}

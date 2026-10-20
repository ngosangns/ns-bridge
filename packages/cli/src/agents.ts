/**
 * `ns-bridge agents` — turn a coding agent on or off.
 *
 * OMP is the only host here with a list: `task.disabledAgents` in
 * `~/.omp/agent/config.yml` (or the profile's agent dir). Pi's subagents are
 * files, not a denylist. DSH has no agent list. Those hosts get an error
 * instead of a guessed file write.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentAction = "enable" | "disable" | "status";

const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface AgentStep {
  line: string;
  apply: () => string | { error: string };
}

export interface AgentPlan {
  steps: AgentStep[];
  error?: string;
}

export function ompConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE;
  const root = profile ? join(home, ".omp", "profiles", profile, "agent") : join(home, ".omp", "agent");
  return join(root, "config.yml");
}

export function planAgents(
  action: AgentAction,
  host: string | undefined,
  name: string | undefined,
  configPath: string,
): AgentPlan {
  if (host !== "omp") {
    return {
      steps: [],
      error: host
        ? `${host} has no coding-agent list ns-bridge can edit (only omp)`
        : "usage: ns-bridge agents enable|disable|status omp [name]",
    };
  }
  if (action === "status") {
    if (name && !AGENT_NAME.test(name)) return { steps: [], error: `invalid agent name ${name}` };
    return {
      steps: [
        {
          line: `omp agents ${configPath}`,
          apply: () => formatAgentStatus(configPath, name),
        },
      ],
    };
  }
  if (!name || !AGENT_NAME.test(name)) {
    return { steps: [], error: name ? `invalid agent name ${name}` : "enable and disable need an agent name" };
  }
  const enabled = action === "enable";
  return {
    steps: [
      {
        line: `omp config ${configPath}: task.disabledAgents ${enabled ? "drop" : "add"} ${name}`,
        apply: () => writeAgent(configPath, name, enabled),
      },
    ],
  };
}

function formatAgentStatus(configPath: string, name: string | undefined): string | { error: string } {
  const disabled = readDisabled(configPath);
  if ("error" in disabled) return disabled;
  if (name) return `${name} ${disabled.names.includes(name) ? "off" : "on"}`;
  if (disabled.names.length === 0) return "no agents disabled";
  return disabled.names.map((agent) => `${agent} off`).join("\n");
}

function writeAgent(configPath: string, name: string, enabled: boolean): string | { error: string } {
  const current = readDisabled(configPath);
  if ("error" in current) return current;
  const has = current.names.includes(name);
  if (enabled && !has) return `${name} already on`;
  if (!enabled && has) return `${name} already off`;
  const next = enabled ? current.names.filter((agent) => agent !== name) : [...current.names, name];
  writeFileSync(configPath, renderDisabled(current.raw, next), "utf8");
  return `${name} ${enabled ? "on" : "off"}`;
}

interface DisabledList {
  raw: string;
  names: string[];
}

function readDisabled(configPath: string): DisabledList | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return { error: `omp config not found: ${configPath}` };
  }
  return { raw, names: disabledNames(raw) };
}

/** Names under `task.disabledAgents`, in file order. A missing key is empty. */
export function disabledNames(raw: string): string[] {
  const lines = raw.split("\n");
  let inTask = false;
  let inList = false;
  const names: string[] = [];
  for (const line of lines) {
    if (!inTask) {
      if (line === "task:") inTask = true;
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    if (!inList) {
      if (line === "  disabledAgents:") inList = true;
      continue;
    }
    if (line.startsWith("    - ")) {
      const name = line.slice("    - ".length).trim();
      if (AGENT_NAME.test(name)) names.push(name);
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    break;
  }
  return names;
}

/**
 * Replace the `task.disabledAgents` list. Other keys stay, comments included.
 * An empty list drops the key. An empty `task:` block drops with it.
 */
export function renderDisabled(raw: string, names: readonly string[]): string {
  const newline = raw.endsWith("\n") || raw.length === 0;
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const taskAt = lines.indexOf("task:");
  if (taskAt === -1) {
    if (names.length === 0) return newline ? `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}` : lines.join("\n");
    const block = ["task:", "  disabledAgents:", ...names.map((name) => `    - ${name}`)];
    const body = lines.join("\n");
    return `${body}${body.length > 0 ? "\n\n" : ""}${block.join("\n")}\n`;
  }

  const taskEnd = nextTopLevel(lines, taskAt + 1);
  const listAt = lines.findIndex((line, index) => index > taskAt && index < taskEnd && line === "  disabledAgents:");
  const withoutList =
    listAt === -1
      ? lines.slice(taskAt + 1, taskEnd)
      : [...lines.slice(taskAt + 1, listAt), ...lines.slice(listItemEnd(lines, listAt + 1, taskEnd), taskEnd)];
  const taskKept = withoutList.some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const middle: string[] = [];
  if (names.length > 0) {
    middle.push("task:", ...withoutList, "  disabledAgents:", ...names.map((name) => `    - ${name}`));
  } else if (taskKept) {
    middle.push("task:", ...withoutList);
  }
  const next = [...lines.slice(0, taskAt), ...middle, ...lines.slice(taskEnd)];
  if (next.length === 0) return "";
  return `${next.join("\n")}\n`;
}

function nextTopLevel(lines: readonly string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) return index;
  }
  return lines.length;
}

function listItemEnd(lines: readonly string[], from: number, taskEnd: number): number {
  for (let index = from; index < taskEnd; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("    - ") || line.trim() === "" || line.trim().startsWith("#")) continue;
    return index;
  }
  return taskEnd;
}

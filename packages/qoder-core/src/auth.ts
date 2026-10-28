// ABOUTME: Resolves Qoder auth for the agent SDK (qodercli session or PAT).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AuthOptions, accessTokenFromEnv, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { QODER_LOGIN_MESSAGE, QoderAuthError } from "./errors.js";

export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";

export type QoderAuthMode = "qodercli" | "pat";

export interface ResolvedQoderAuth {
  mode: QoderAuthMode;
  options: AuthOptions;
}

/** Config directory qodercli uses. `QODER_CONFIG_DIR` wins over `~/.qoder`. */
export function qoderConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const direct = env.QODER_CONFIG_DIR?.trim();
  if (direct) return direct;
  const root = env.QODER_CLI_HOME?.trim() || home;
  return join(root, ".qoder");
}

/** True when `qodercli login` has written a session under the config dir. */
export function qodercliSessionPresent(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const dir = join(qoderConfigDir(env, home), ".auth");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => name !== ".lock" && !name.endsWith(".lock"));
  } catch {
    return false;
  }
}

/** Build SDK auth options from env. PAT wins over the local qodercli session. */
export function resolveQoderAuth(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ResolvedQoderAuth | undefined {
  const pat = env[QODER_PAT_ENV]?.trim();
  if (pat) {
    return { mode: "pat", options: accessTokenFromEnv(QODER_PAT_ENV) };
  }
  if (env.QODER_SKIP_QODERCLI_AUTH === "1") return undefined;
  if (!qodercliSessionPresent(env, home)) return undefined;
  return { mode: "qodercli", options: qodercliAuth() };
}

export function requireQoderAuth(env: NodeJS.ProcessEnv = process.env, home = homedir()): ResolvedQoderAuth {
  const auth = resolveQoderAuth(env, home);
  if (!auth) throw new QoderAuthError(QODER_LOGIN_MESSAGE);
  return auth;
}

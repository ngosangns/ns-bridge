// ABOUTME: Resolves the Qoder bearer token from the qodercli store or a PAT.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QODER_LOGIN_MESSAGE, QoderAuthError } from "./errors.js";
import { readQoderStore } from "./store.js";

export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";

export type QoderAuthMode = "qodercli" | "pat";

export interface ResolvedQoderAuth {
  mode: QoderAuthMode;
  token: string;
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

/** Bearer token for the model server. PAT wins over the local qodercli session. */
export function resolveQoderAuth(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ResolvedQoderAuth | undefined {
  const pat = env[QODER_PAT_ENV]?.trim();
  if (pat) return { mode: "pat", token: pat };
  if (env.QODER_SKIP_QODERCLI_AUTH === "1") return undefined;
  if (!qodercliSessionPresent(env, home)) return undefined;
  try {
    const store = readQoderStore(qoderConfigDir(env, home));
    const token = store.securityOauthToken ?? store.accessToken;
    return token ? { mode: "qodercli", token } : undefined;
  } catch {
    // A session that cannot be decrypted is as good as absent. Presence
    // checks stay total; requireQoderAuth turns this into the login error.
    return undefined;
  }
}

export function requireQoderAuth(env: NodeJS.ProcessEnv = process.env, home = homedir()): ResolvedQoderAuth {
  const auth = resolveQoderAuth(env, home);
  if (!auth) throw new QoderAuthError(QODER_LOGIN_MESSAGE);
  return auth;
}

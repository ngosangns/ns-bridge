// ABOUTME: Reads the Grok CLI login session and refreshes its short-lived access token.
// ABOUTME: A console.x.ai API key is a different credential and is never read here.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, type FileHandle, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GROK_LOGIN_MESSAGE, GrokAuthError } from "./errors.js";

export const DEFAULT_OIDC_ISSUER = "https://auth.x.ai";
export const DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

/** Refresh when the access token expires inside this window. */
const REFRESH_SKEW_MS = 60_000;

/** Used only when the token endpoint omits `expires_in`. */
const FALLBACK_EXPIRES_IN_SECONDS = 3600;

const tokenEndpoints = new Map<string, string>();

/** One refresh per auth file. Overlapping turns in this process share it. */
const refreshFlights = new Map<string, Promise<{ accessToken: string }>>();

/** How long a second process waits for the lock holder to finish a refresh. */
const LOCK_WAIT_MS = 20_000;

/** A lock older than this is from a crashed process and can be replaced. */
const LOCK_STALE_MS = 30_000;

export interface GrokAccount {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  auth_mode?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  [extra: string]: unknown;
}

export interface LoadGrokAccessOptions {
  /** Use this file only. Tests pass it so a missing file does not fall through to the real home. */
  authPath?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function resetGrokAuthCacheForTests(): void {
  tokenEndpoints.clear();
  refreshFlights.clear();
}

/** Candidate auth files. An explicit `GROK_AUTH_PATH` wins, then the CLI home, then the workspace creds dir. */
export function grokAuthCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const explicit = env.GROK_AUTH_PATH?.trim();
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  paths.push(join(home, ".grok", "auth.json"));
  paths.push(join("/workspace/.provider-creds/grok", "auth.json"));
  return paths;
}

function isAccount(value: unknown): value is GrokAccount {
  return !!value && typeof value === "object" && ("key" in value || "refresh_token" in value);
}

/**
 * Prefer the OIDC record that can refresh. A file may hold more than one account;
 * the CLI's record is the key that contains `auth.x.ai` and has both tokens.
 */
export function pickGrokAccount(file: Record<string, unknown>): { key: string; account: GrokAccount } | undefined {
  const entries = Object.entries(file).filter((entry): entry is [string, GrokAccount] => isAccount(entry[1]));
  const preferred = entries.find(
    ([key, account]) => key.includes("auth.x.ai") && !!account.key && !!account.refresh_token,
  );
  if (preferred) return { key: preferred[0], account: preferred[1] };
  const withBoth = entries.find(([, account]) => !!account.key && !!account.refresh_token);
  if (withBoth) return { key: withBoth[0], account: withBoth[1] };
  const withKey = entries.find(([, account]) => !!account.key);
  if (withKey) return { key: withKey[0], account: withKey[1] };
  return undefined;
}

function expiresAtMs(expiresAt: string | undefined): number | undefined {
  if (!expiresAt) return undefined;
  const time = Date.parse(expiresAt);
  return Number.isNaN(time) ? undefined : time;
}

/** True when the access token should be refreshed, including when it is already expired. */
export function tokenExpiresSoon(expiresAt: string | undefined, now: number, skew = REFRESH_SKEW_MS): boolean {
  const time = expiresAtMs(expiresAt);
  if (time === undefined) return false;
  return time - now <= skew;
}

/** True when the access token is still accepted, even if it is inside the refresh window. */
export function tokenStillValid(expiresAt: string | undefined, now: number): boolean {
  const time = expiresAtMs(expiresAt);
  if (time === undefined) return !expiresAt;
  return time > now;
}

function clientIdOf(accountKey: string, account: GrokAccount): string | undefined {
  const stored = account.oidc_client_id?.trim();
  if (stored) return stored;
  const tail = accountKey.split("::").at(-1)?.trim();
  return tail || undefined;
}

export async function resolveTokenEndpoint(issuer: string, fetchImpl: typeof fetch): Promise<string> {
  const normalized = issuer.replace(/\/$/, "") || DEFAULT_OIDC_ISSUER;
  if (normalized === DEFAULT_OIDC_ISSUER) return DEFAULT_TOKEN_ENDPOINT;
  const cached = tokenEndpoints.get(normalized);
  if (cached) return cached;
  const response = await fetchImpl(`${normalized}/.well-known/openid-configuration`);
  if (!response.ok) throw new GrokAuthError();
  const json = (await response.json()) as { token_endpoint?: string };
  if (!json.token_endpoint) throw new GrokAuthError();
  tokenEndpoints.set(normalized, json.token_endpoint);
  return json.token_endpoint;
}

export async function refreshGrokAccess(input: {
  refreshToken: string;
  clientId: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = await resolveTokenEndpoint(input.issuer ?? DEFAULT_OIDC_ISSUER, fetchImpl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new GrokAuthError();
  const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new GrokAuthError();
  const expiresIn =
    typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : FALLBACK_EXPIRES_IN_SECONDS;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn };
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path, constants.R_OK);
      return path;
    } catch {
      // The next candidate may exist.
    }
  }
  return undefined;
}

async function readAuthFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new GrokAuthError();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GrokAuthError();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GrokAuthError) throw error;
    throw new GrokAuthError();
  }
}

/**
 * Rewrite only the token fields of one account. The file is read again immediately
 * before the write so a refresh that landed in between is left in place.
 */
export async function storeRefreshedToken(
  path: string,
  accountKey: string,
  originalRefreshToken: string | undefined,
  update: { accessToken: string; refreshToken?: string; expiresAt: string },
): Promise<"stored" | "skipped"> {
  const file = await readAuthFile(path);
  const current = file[accountKey];
  if (!isAccount(current)) return "skipped";
  if (originalRefreshToken && current.refresh_token && current.refresh_token !== originalRefreshToken) {
    return "skipped";
  }
  current.key = update.accessToken;
  current.expires_at = update.expiresAt;
  if (update.refreshToken) current.refresh_token = update.refreshToken;
  file[accountKey] = current;
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return "stored";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exclusive lock beside the auth file so two processes do not rotate one refresh token. */
async function acquireAuthLock(authPath: string): Promise<FileHandle> {
  const lockPath = `${authPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // The holder removed the lock between the failed create and this stat.
      }
      if (Date.now() > deadline) throw new GrokAuthError(GROK_LOGIN_MESSAGE);
      await delay(25);
    }
  }
}

async function releaseAuthLock(authPath: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await rm(`${authPath}.lock`, { force: true }).catch(() => undefined);
}

async function persistRefreshedToken(
  path: string,
  accountKey: string,
  originalRefreshToken: string | undefined,
  update: { accessToken: string; refreshToken?: string; expiresAt: string },
): Promise<"stored" | "skipped"> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await storeRefreshedToken(path, accountKey, originalRefreshToken, update);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function refreshSessionLocked(path: string, options: LoadGrokAccessOptions): Promise<{ accessToken: string }> {
  const file = await readAuthFile(path);
  const picked = pickGrokAccount(file);
  const accessToken = picked?.account.key;
  if (!picked || !accessToken) throw new GrokAuthError(GROK_LOGIN_MESSAGE);

  const now = options.now ?? Date.now();
  if (!tokenExpiresSoon(picked.account.expires_at, now)) return { accessToken };

  const clientId = clientIdOf(picked.key, picked.account);
  if (!picked.account.refresh_token || !clientId) {
    if (tokenStillValid(picked.account.expires_at, now)) return { accessToken };
    throw new GrokAuthError(GROK_LOGIN_MESSAGE);
  }

  let refreshed: { accessToken: string; refreshToken?: string; expiresIn: number };
  try {
    refreshed = await refreshGrokAccess({
      refreshToken: picked.account.refresh_token,
      clientId,
      issuer: picked.account.oidc_issuer,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    if (tokenStillValid(picked.account.expires_at, now)) return { accessToken };
    if (error instanceof GrokAuthError) throw error;
    throw new GrokAuthError(GROK_LOGIN_MESSAGE);
  }

  const expiresAt = new Date(now + refreshed.expiresIn * 1000).toISOString();
  const update = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt,
  };
  let outcome: "stored" | "skipped";
  try {
    outcome = await persistRefreshedToken(path, picked.key, picked.account.refresh_token, update);
  } catch {
    // A write failure leaves the previous refresh token on disk. That token still
    // works when the server did not rotate it. A rotated token exists only in this
    // call, so losing the write means the user has to sign in again.
    if (!refreshed.refreshToken) return { accessToken: refreshed.accessToken };
    throw new GrokAuthError(GROK_LOGIN_MESSAGE);
  }
  if (outcome === "skipped") {
    const latest = pickGrokAccount(await readAuthFile(path));
    if (latest?.account.key) return { accessToken: latest.account.key };
  }
  return { accessToken: refreshed.accessToken };
}

async function refreshSession(path: string, options: LoadGrokAccessOptions): Promise<{ accessToken: string }> {
  const handle = await acquireAuthLock(path);
  try {
    return await refreshSessionLocked(path, options);
  } finally {
    await releaseAuthLock(path, handle);
  }
}

/** The access token for one Responses call. Refreshes the CLI session when it is near expiry. */
export async function loadGrokAccess(options: LoadGrokAccessOptions = {}): Promise<{ accessToken: string }> {
  const path = options.authPath ?? (await firstExisting(grokAuthCandidates(options.env, options.home ?? homedir())));
  if (!path) throw new GrokAuthError(GROK_LOGIN_MESSAGE);
  const current = refreshFlights.get(path);
  if (current) return current;
  const flight = refreshSession(path, options);
  refreshFlights.set(path, flight);
  try {
    return await flight;
  } finally {
    if (refreshFlights.get(path) === flight) refreshFlights.delete(path);
  }
}

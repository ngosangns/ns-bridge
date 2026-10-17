// ABOUTME: The Devin CLI credential store: a flat TOML file at
// ABOUTME: ~/.local/share/devin/credentials.toml shared with `devin auth`.
// ABOUTME: Reading and writing the file runs in the ns-bridge binary. These
// ABOUTME: functions stay synchronous because Pi resolves a token while
// ABOUTME: registering the provider, so they use `ns-bridge call --ignore-stdin-eof`.

import { homedir } from "node:os";
import { join } from "node:path";
import { sidecarCallSync } from "ns-bridge-core/sidecar";
import { credentialsFromToken, type DevinCredentials } from "./oauth.js";

/** Keys the CLI credential file carries that this provider reads or writes. */
export interface DevinStoredCredentials {
  /** Cascade session token (`devin-session-token$…` once normalized). */
  apiKey: string;
  /** Cascade API base the CLI recorded at login; overrides the default. */
  apiServerUrl?: string;
  /** Management API base recorded at login. */
  devinApiUrl?: string;
  /** Webapp host recorded at login. */
  devinWebappHost?: string;
}

/** `credentials.toml` location; `DEVIN_CREDENTIALS_PATH` overrides (tests). */
export function devinCredentialsPath(): string {
  const override = process.env.DEVIN_CREDENTIALS_PATH;
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "devin", "credentials.toml");
}

/**
 * Read the machine's Devin session. Returns `undefined` when the file is
 * missing or carries no usable token — the caller decides whether to prompt.
 * The file itself is read by `ns-bridge call --vendor devin --op loadCredentials`.
 */
export function resolveDevinCredentials(): DevinStoredCredentials | undefined {
  const stored = sidecarCallSync<DevinStoredCredentials | null>("devin", "loadCredentials", {});
  return stored ?? undefined;
}

/** The session as {@link DevinCredentials}, or `undefined` when logged out. */
export function resolveDevinSession(): DevinCredentials | undefined {
  const stored = resolveDevinCredentials();
  return stored ? credentialsFromToken(stored.apiKey) : undefined;
}

/**
 * Persist a session token so the Devin CLI and this provider share it.
 * Existing unrelated keys in the file are preserved. The write runs in
 * `ns-bridge call --vendor devin --op saveCredentials`.
 */
export function saveDevinCredentials(apiKey: string, extras?: Partial<DevinStoredCredentials>): void {
  sidecarCallSync("devin", "saveCredentials", {
    apiKey,
    ...(extras?.apiServerUrl ? { apiServerUrl: extras.apiServerUrl } : {}),
    ...(extras?.devinApiUrl ? { devinApiUrl: extras.devinApiUrl } : {}),
    ...(extras?.devinWebappHost ? { devinWebappHost: extras.devinWebappHost } : {}),
  });
}

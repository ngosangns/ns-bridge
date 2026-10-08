// ABOUTME: Login and refresh for OMP's /login flow, over the sessions this machine already has.
// ABOUTME: The flow itself is host-neutral and lives in kiro-core (shared with the Pi provider).

import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import {
  type KiroCredentials,
  loginKiroFromSession,
  type ResolvedKiroRequestCredentials,
  refreshKiroToken,
  resolveKiroRequestCredentials,
} from "ns-kiro-core";

export type { ResolvedKiroRequestCredentials };

export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return (await loginKiroFromSession(callbacks)) as unknown as OAuthCredentials;
}

export async function refreshKiroCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return (await refreshKiroToken(credentials as unknown as KiroCredentials)) as unknown as OAuthCredentials;
}

export function getKiroApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

/** See {@link resolveKiroRequestCredentials}: which credential one request or catalog fetch runs on. */
export const resolveRequestCredentials = resolveKiroRequestCredentials;

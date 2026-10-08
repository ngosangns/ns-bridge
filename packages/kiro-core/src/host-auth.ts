// ABOUTME: Login and per-request credential choice for agent hosts (Pi, OMP), over the
// ABOUTME: sessions this machine already has. Host-neutral: hosts pass their own callbacks.

import { resolveApiRegion } from "./endpoints.js";
import { isApiKey, type KiroCredentials, loginKiroWithApiKey, resolveKiroCredentials } from "./oauth.js";

/** The subset of a host's login callbacks this flow uses (Pi's and OMP's both fit). */
export interface KiroHostLoginCallbacks {
  onProgress?: (message: string) => void;
  onPrompt?: (prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    secret?: boolean;
  }) => Promise<string>;
}

export const KIRO_NO_SESSION_MESSAGE =
  "No Kiro session found. Sign in with `kiro-cli login` (Builder ID, IAM Identity Center, Google, or GitHub), " +
  "then run /login kiro again — or paste a Kiro API key below.";

/**
 * No browser flow of its own: every interactive method Kiro supports already
 * lands a session in the kiro-cli store or the Kiro IDE token file, so this
 * reads one of those (refreshing it when needed). The one credential with no
 * browser step — an API key — is accepted directly.
 */
export async function loginKiroFromSession(callbacks: KiroHostLoginCallbacks): Promise<KiroCredentials> {
  callbacks.onProgress?.("Looking for an existing Kiro session…");
  const existing = await resolveKiroCredentials();
  if (existing) {
    callbacks.onProgress?.(`Using the ${existing.authMethod} session from kiro-cli.`);
    return existing;
  }

  if (!callbacks.onPrompt) throw new Error(KIRO_NO_SESSION_MESSAGE);
  const apiKey = (
    await callbacks.onPrompt({
      message: KIRO_NO_SESSION_MESSAGE,
      placeholder: "ksk_…",
      allowEmpty: true,
      secret: true,
    })
  ).trim();
  if (!apiKey) throw new Error(KIRO_NO_SESSION_MESSAGE);
  return loginKiroWithApiKey(apiKey, callbacks.onProgress);
}

/** The token, region, and profile one request runs on. */
export interface ResolvedKiroRequestCredentials {
  accessToken: string;
  region: string;
  profileArn?: string;
}

/**
 * Decide which credential a request or catalog fetch runs on.
 *
 * The key a host resolves for the provider is the session returned from
 * `/login kiro` — but it can also be an unresolved env reference such as
 * `$KIRO_API_KEY` verbatim, and Kiro answers a bogus bearer with a 403 the core
 * then has to recover from. So a host key is trusted only when it is
 * recognizably a Kiro credential; anything else defers to the store, which is
 * where the session actually lives.
 *
 * The stored record also carries the region and the profile ARN, and passing
 * the ARN skips the ListAvailableProfiles round trip that a social login cannot
 * answer anyway.
 */
export async function resolveKiroRequestCredentials(
  hostKey: string | undefined,
): Promise<ResolvedKiroRequestCredentials> {
  const stored = await resolveKiroCredentials();
  const region = resolveApiRegion(stored?.region);
  if (hostKey && (isApiKey(hostKey) || hostKey === stored?.access)) {
    return { accessToken: hostKey, region, ...(stored?.profileArn ? { profileArn: stored.profileArn } : {}) };
  }
  if (stored) {
    return {
      accessToken: stored.access,
      region,
      ...(stored.profileArn ? { profileArn: stored.profileArn } : {}),
    };
  }
  if (hostKey) return { accessToken: hostKey, region };
  throw new Error("Kiro credentials not set. Run `kiro-cli login`, or set KIRO_API_KEY to a `ksk_` API key.");
}

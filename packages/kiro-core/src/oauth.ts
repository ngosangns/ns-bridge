// Kiro credentials and token refresh.
//
// Auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO)
//   - "desktop": Google/GitHub social login via the Kiro auth service
//   - "external-idp": enterprise OIDC (e.g. Okta)
//   - "apikey": a long-lived `ksk_` bearer token
//
// Sessions are established by `kiro-cli login` or the Kiro IDE; this package
// reads and refreshes them rather than running its own interactive login.

import { formatSafeError } from "./debug.js";
import { resolveApiRegion } from "./endpoints.js";

// The Go vendor refreshes against its own copy of this host
// (defaultOIDCEndpoint, a {region} template, in go/internal/vendors/kiro/ops.go).
// Keep in lockstep — test/go-parity.test.ts pins it. The rest of this block is
// public API constants the login orchestration does not itself dereference.
export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";

export interface KiroCredentials {
  /** Bearer token sent on every runtime and management request. */
  access: string;
  /** Pipe-packed refresh material; the last segment names the auth method. */
  refresh: string;
  /** Epoch milliseconds, already reduced by the 5-minute expiry buffer. */
  expires: number;
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
  profileArn?: string;
  startUrl?: string;
  isEnterprise?: boolean;
}

/**
 * Which of this machine's two Kiro sessions the provider signs in with.
 *
 * `kiro-cli` and the Kiro IDE store independent logins, and those logins can be
 * different IdC users of the same Kiro profile — one out of monthly requests
 * while the other still has credits. `cli` (the default) signs in with the
 * kiro-cli store and treats the IDE's session as a fallback; `ide` is the
 * reverse, for a machine whose IDE holds the session the user actually wants.
 */
export type KiroAuthSource = "cli" | "ide";

const AUTH_SOURCE_ENV = "KIRO_AUTH_SOURCE";

/**
 * Read {@link KiroAuthSource} from the environment.
 *
 * An unrecognized value is reported and treated as the default rather than
 * silently obeyed: a typo that quietly signs the machine in as the other
 * account would surface as the wrong account's quota, which is the failure this
 * setting exists to avoid.
 */
export function resolveKiroAuthSource(): KiroAuthSource {
  const configured = process.env[AUTH_SOURCE_ENV]?.trim().toLowerCase();
  if (!configured) return "cli";
  if (configured === "cli" || configured === "ide") return configured;
  console.warn(`[kiro-core] Ignoring ${AUTH_SOURCE_ENV}=${configured}: expected "cli" or "ide".`);
  return "cli";
}

export function isApiKey(token: string): boolean {
  return token.startsWith("ksk_");
}

/**
 * Validate a `ksk_` API key and resolve the profile it bills against.
 *
 * Unlike an SSO session this needs no browser round trip, so it is the one
 * credential this package can establish on its own: GetProfile with an empty
 * body returns the key's own profile, which both proves the key works and
 * supplies the ARN every runtime request needs.
 */
export async function loginKiroWithApiKey(
  apiKey: string,
  onProgress?: (message: string) => void,
): Promise<KiroCredentials> {
  if (!apiKey.startsWith("ksk_")) {
    throw new Error("Invalid API key format. Kiro API keys start with 'ksk_'.");
  }
  // The GetProfile validation runs in the ns-bridge binary, which also
  // resolves the profile ARN the key bills against.
  const { sidecarLogin } = await import("ns-bridge-core/sidecar");
  const credentials = await sidecarLogin<KiroCredentials>(
    "kiro",
    { apiKey },
    { ...(onProgress ? { onProgress } : {}) },
  );
  return credentials;
}

export function isExpired(credentials: KiroCredentials): boolean {
  return Date.now() >= credentials.expires;
}

/**
 * Kick off a catalog refresh for a session's region. Deliberately not awaited
 * past the import: a stale catalog degrades model metadata, while a slow one
 * would delay every request that had to reauthenticate. The binary has exited
 * by the time this runs, so the refresh stays in this process.
 */
async function scheduleKiroCatalogRefresh(credentials: KiroCredentials): Promise<void> {
  if (process.env.VITEST) return;
  try {
    const { updateKiroModelsCache } = await import("./models.js");
    const region = resolveApiRegion(credentials.region);
    updateKiroModelsCache(credentials.access, region, credentials.profileArn).catch((error) => {
      console.warn(`[kiro-core] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
    });
  } catch (error) {
    console.warn(`[kiro-core] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
  }
}

/**
 * Refresh a session and kick off a catalog refresh for its region.
 *
 * Store selection, the network refresh and writing the result back run in the
 * `refreshSession` op. This function only forwards the credential and schedules
 * the catalog, which has to outlive the one-shot binary.
 */
export async function refreshKiroToken(credentials: KiroCredentials): Promise<KiroCredentials> {
  const { runKiroOp } = await import("./engine-ops.js");
  const refreshed = await runKiroOp<KiroCredentials>("refreshSession", () => ({ credentials }));
  await scheduleKiroCatalogRefresh(refreshed);
  return refreshed;
}

/**
 * Resolve a usable session from the stores this machine already has. The
 * preferred store (`KIRO_AUTH_SOURCE`, default `cli`) is used or refreshed
 * before the other store is consulted, because the two are separate logins.
 * The `resolveCredentials` op does that work; a session it had to refresh is
 * marked so the catalog refresh still happens in this process.
 */
export async function resolveKiroCredentials(): Promise<KiroCredentials | undefined> {
  const { runKiroOp } = await import("./engine-ops.js");
  const result = await runKiroOp<(KiroCredentials & { kiroSessionRefreshed?: boolean }) | null>(
    "resolveCredentials",
    () => ({}),
  );
  if (!result) return undefined;
  const { kiroSessionRefreshed, ...credentials } = result;
  if (kiroSessionRefreshed) await scheduleKiroCatalogRefresh(credentials);
  return credentials;
}

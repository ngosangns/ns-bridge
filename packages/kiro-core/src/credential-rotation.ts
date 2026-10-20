// ABOUTME: What a rejected Kiro credential is replaced with.
// ABOUTME: Both the profile-discovery 403 and the runtime 403 rotate the same way, so the policy lives once.

import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, refreshViaKiroCli } from "./kiro-cli.js";
import { invalidateKiroProfileArn, type KiroManagementAuth, resolveKiroProfileArn } from "./management.js";
import type { KiroCredentials } from "./oauth.js";

/**
 * The credential a turn is currently signed in as, and where it stands.
 *
 * `region` is the region the request started in. A replacement credential can
 * carry a profile that lives somewhere else; resolving that is the caller's
 * job, since only the caller knows which endpoint it has to re-pin.
 */
export interface KiroCredentialState {
  accessToken: string;
  region: string;
  profileArn?: string;
}

/** Where a rotated credential came from, so a log can say which path won. */
export type KiroCredentialRotationSource = "store" | "kiro-cli" | "unchanged";

export interface KiroRotatedCredential {
  accessToken: string;
  /** The profile the replacement credential carries, when it carries one. */
  profileArn?: string;
  source: KiroCredentialRotationSource;
}

/**
 * The profile ARN the stream tests pin, so they exercise the request loop
 * without a management round trip.
 *
 * Absent unless a test opted in. Production never sets it, which is what keeps
 * the test seam out of the request path: the call sites below only branch on
 * whether it is present.
 */
let pinnedProfileArn: string | undefined;

/** Pin profile resolution to a fixed ARN. Pass `undefined` to resolve for real again. */
export function pinProfileArnForTests(profileArn: string | undefined): void {
  pinnedProfileArn = profileArn;
}

/**
 * Replace a credential the service just rejected.
 *
 * Another process may already have rotated the shared kiro-cli store, so that
 * store is read first and a refresh is only forced when it still holds the
 * rejected token. Returns the credential unchanged, with `source: "unchanged"`,
 * when neither path yields a replacement.
 */
export function rotateRejectedKiroCredential(rejectedAccessToken: string): KiroRotatedCredential {
  const stored = getKiroCliCredentials();
  if (stored?.access && stored.access !== rejectedAccessToken) {
    return { accessToken: stored.access, profileArn: stored.profileArn, source: "store" };
  }
  const refreshed = refreshViaKiroCli();
  if (refreshed?.access) {
    return { accessToken: refreshed.access, profileArn: refreshed.profileArn, source: "kiro-cli" };
  }
  return { accessToken: rejectedAccessToken, source: "unchanged" };
}

/**
 * The profile ARN a turn starts from, before any request is sent.
 *
 * The model and the request can both name one, and so can the kiro-cli store
 * when it is the store this access token came from. Only when none of them do
 * is the profile resolved from the management API.
 */
export async function resolveInitialProfileArn(
  auth: KiroManagementAuth,
  hintedArn: string | undefined,
): Promise<string> {
  if (hintedArn) return hintedArn;
  const stored = getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired();
  if (stored?.access === auth.accessToken && stored.profileArn) return stored.profileArn;
  return resolveProfileArn(auth);
}

/**
 * The profile ARN to retry a runtime 403 with.
 *
 * The rejected credential's profile only survives the rotation when both sides
 * are desktop logins: a social profile is not always discoverable through the
 * management API, so dropping it would turn a recoverable 403 into a hard one.
 * Any other combination resolves the profile afresh.
 */
export async function resolveRotatedProfileArn(
  auth: KiroManagementAuth,
  rejectedAccessToken: string,
  rejectedProfileArn: string,
  rotated: KiroRotatedCredential,
): Promise<string> {
  invalidateKiroProfileArn({ accessToken: rejectedAccessToken, region: auth.region });
  if (rotated.profileArn) return rotated.profileArn;
  if (rotated.source !== "unchanged" && sameDesktopLogin(rejectedAccessToken, rotated.accessToken)) {
    return rejectedProfileArn;
  }
  return resolveProfileArn(auth);
}

/** Both credentials are desktop logins, so the rejected profile is safe to keep. */
function sameDesktopLogin(rejectedAccessToken: string, replacementAccessToken: string): boolean {
  return (
    desktopCredentialFor(rejectedAccessToken) !== undefined &&
    desktopCredentialFor(replacementAccessToken) !== undefined
  );
}

function desktopCredentialFor(accessToken: string): KiroCredentials | undefined {
  const fresh = getKiroCliCredentials();
  const credential = fresh?.access === accessToken ? fresh : getKiroCliCredentialsAllowExpired();
  if (credential?.access !== accessToken || credential.authMethod !== "desktop") return undefined;
  return credential;
}

function resolveProfileArn(auth: KiroManagementAuth): Promise<string> {
  if (pinnedProfileArn) return Promise.resolve(pinnedProfileArn);
  return resolveKiroProfileArn(auth);
}

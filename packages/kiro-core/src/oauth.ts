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
import { getKiroEndpoints } from "./endpoints.js";
import { KIRO_USER_AGENTS, kiroFetch, kiroSdkUserAgent } from "./http.js";
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired } from "./kiro-cli.js";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
import { isApiKey, kiroAuthHeaders } from "./token-type.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";

export interface KiroCredentials {
  /** Bearer token sent on every runtime and management request. */
  access: string;
  /** Pipe-packed refresh material; the last segment names the auth method. */
  refresh: string;
  /** Epoch milliseconds, already reduced by {@link EXPIRES_BUFFER_MS}. */
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

/** @deprecated The user-agent table lives in {@link KIRO_USER_AGENTS}. */
export const KIRO_DESKTOP_USER_AGENT = KIRO_USER_AGENTS.desktop;

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

/** @deprecated Use {@link kiroSdkUserAgent}. Kept so existing deep imports still resolve. */
export const kiroUserAgent = kiroSdkUserAgent;

export { isApiKey, kiroAuthHeaders };

/** Region Kiro issues API keys against. Management calls for a `ksk_` key go here. */
const API_KEY_REGION = "us-east-1";

/**
 * The GetProfile request every API-key flow shares. Login and profile
 * resolution classify the response differently; the request itself does not.
 */
export async function fetchApiKeyGetProfile(accessToken: string): Promise<Response> {
  try {
    return await kiroFetch(getKiroEndpoints(API_KEY_REGION).management, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
        ...kiroAuthHeaders(accessToken),
        ...kiroSdkUserAgent("codewhispererruntime", "F,C"),
      },
      body: "{}",
    });
  } catch (error) {
    throw new Error(`Kiro management GetProfile request failed in ${API_KEY_REGION}`, { cause: error });
  }
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

  onProgress?.("Validating API key...");

  const response = await fetchApiKeyGetProfile(apiKey);

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    if (response.status === 401 || response.status === 403 || /Invalid token/i.test(detail)) {
      throw new Error("API key was rejected by Kiro. Check that the key is valid and not expired.");
    }
    throw new Error(`Kiro GetProfile failed: ${response.status} ${response.statusText} ${detail}`.trim());
  }

  const data = (await response.json()) as { profile?: { arn?: string } };
  const profileArn = data.profile?.arn;

  return {
    access: apiKey,
    refresh: `${apiKey}|apikey`,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    clientId: "",
    clientSecret: "",
    region: API_KEY_REGION,
    authMethod: "apikey",
    ...(profileArn ? { profileArn } : {}),
  };
}

export function isExpired(credentials: KiroCredentials): boolean {
  return Date.now() >= credentials.expires;
}

/** Refresh a session. The model catalog stays on disk until `ns-bridge models refresh`. */
export async function refreshKiroToken(credentials: KiroCredentials): Promise<KiroCredentials> {
  return refreshKiroTokenInternal(credentials);
}

async function refreshKiroTokenInternal(credentials: KiroCredentials): Promise<KiroCredentials> {
  const {
    getKiroCliCredentials,
    getKiroCliCredentialsAllowExpired,
    saveKiroCliCredentials,
    getKiroCliSocialToken,
    getKiroCliSocialTokenAllowExpired,
  } = await import("./kiro-cli.js");
  const credentialAuthMethod =
    credentials.authMethod ?? (credentials.refresh.split("|").at(-1) === "desktop" ? "desktop" : "idc");
  const getValidCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialToken();
    const cliCreds = getKiroCliCredentials();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };
  const getExpiredCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialTokenAllowExpired();
    const cliCreds = getKiroCliCredentialsAllowExpired();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };

  // API key credentials are long-lived bearer tokens — there is nothing to
  // refresh. Return them unchanged so the same key keeps being used.
  if (credentials.authMethod === "apikey" || isApiKey(credentials.access)) return credentials;

  // Both stores hold IDC logins against the same Kiro profile, but they need not
  // be the same user: the IDE can be signed into one that has run out of monthly
  // requests while the kiro-cli session still has credits. A fresh session may
  // therefore replace this credential only when it is the *same login*; a
  // credential that is neither store's current login (an older host-held one)
  // follows KIRO_AUTH_SOURCE instead. A social/desktop session is never replaced
  // by either IDC session.
  const cliSession = getValidCliCredentials();
  const cliStaleSession = getExpiredCliCredentials();
  const ideSession = credentialAuthMethod === "idc" ? getKiroIdeCredentials() : undefined;
  const ideStaleSession = credentialAuthMethod === "idc" ? getKiroIdeCredentialsAllowExpired() : undefined;

  const cliIsThisLogin = (cliSession ?? cliStaleSession)?.refresh === credentials.refresh;
  const ideIsThisLogin = (ideSession ?? ideStaleSession)?.refresh === credentials.refresh;
  const replacement = cliIsThisLogin
    ? cliSession
    : ideIsThisLogin
      ? ideSession
      : resolveKiroAuthSource() === "ide"
        ? (ideSession ?? cliSession)
        : (cliSession ?? ideSession);
  if (replacement) return replacement;

  try {
    const refreshed = await refreshKiroTokenDirect(credentials);
    // Write refreshed tokens back to kiro-cli's store so both stay in sync —
    // except when this credential is the IDE's own login, whose token would
    // otherwise take over the kiro-cli session it is unrelated to.
    if (!ideIsThisLogin) saveKiroCliCredentials(refreshed);
    return refreshed;
  } catch (refreshError) {
    // The CLI may have rotated the refresh token between the pre-check and the
    // network call. Re-read only the matching auth family.
    const retryCreds = getValidCliCredentials();
    if (retryCreds) return retryCreds;

    // The CLI may have a newer refresh token with an expired access token. The
    // stale session read for the pre-check is reused rather than read again: a
    // rotation during the call is already caught by the fresh re-read above, and
    // one read per store per refresh keeps this path from touching the store
    // twice.
    if (cliStaleSession && cliStaleSession.refresh !== credentials.refresh) {
      try {
        const refreshedFromCli = await refreshKiroTokenDirect(cliStaleSession);
        saveKiroCliCredentials(refreshedFromCli);
        return refreshedFromCli;
      } catch {
        // Also failed; continue to the remaining fallbacks.
      }
    }

    // `expires` carries a 5-minute buffer, so the actual token may still work.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

/**
 * The network half of a refresh (desktop, external IdP or IAM Identity Center
 * token endpoint). Which store to trust and where to save stays in
 * {@link refreshKiroTokenInternal}.
 */
async function refreshKiroTokenDirect(credentials: KiroCredentials): Promise<KiroCredentials> {
  return refreshKiroTokenDirectInProcess(credentials);
}

/** Overrides the desktop refresh URL; `{region}` is substituted (tests, proxies). */
export const KIRO_DESKTOP_REFRESH_ENDPOINT_ENV = "KIRO_DESKTOP_REFRESH_ENDPOINT";
/** Overrides the SSO OIDC base URL; `{region}` is substituted (tests, proxies). */
export const KIRO_OIDC_ENDPOINT_ENV = "KIRO_OIDC_ENDPOINT";

function endpointFromEnv(name: string, fallback: string, region: string): string {
  return (process.env[name]?.trim() || fallback).replaceAll("{region}", region);
}

async function refreshKiroTokenDirectInProcess(credentials: KiroCredentials): Promise<KiroCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = credentials.region || "us-east-1";

  if (authMethod === "apikey") return credentials;

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint.
    const url = endpointFromEnv(KIRO_DESKTOP_REFRESH_ENDPOINT_ENV, KIRO_DESKTOP_REFRESH_URL, region);
    const response = await kiroFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": KIRO_USER_AGENTS.desktop },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - EXPIRES_BUFFER_MS,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: data.profileArn || credentials.profileArn,
      startUrl: credentials.startUrl,
    };
  }

  // External IdP (enterprise OIDC, e.g. Okta) — standard public-client refresh
  // against the customer's own token endpoint. kiro-cli does the same:
  // form-encoded grant_type/client_id/refresh_token, snake_case response, and
  // no client secret because the OIDC app is a public PKCE client.
  if (authMethod === "external-idp") {
    const idpClientId = parts[1] ?? "";
    const tokenEndpoint = parts[2] ?? "";
    if (!tokenEndpoint) throw new Error("External IdP token refresh: missing token endpoint");
    const response = await kiroFetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": KIRO_USER_AGENTS.externalIdp,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: idpClientId,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error(`External IdP token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error("External IdP token refresh: missing access_token");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    return {
      refresh: `${data.refresh_token || refreshToken}|${idpClientId}|${tokenEndpoint}|external-idp`,
      access: data.access_token,
      expires: Date.now() + expiresIn * 1000 - EXPIRES_BUFFER_MS,
      clientId: idpClientId,
      clientSecret: "",
      region,
      authMethod: "external-idp",
      profileArn: credentials.profileArn,
    };
  }

  // IDC auth method — SSO OIDC refresh.
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = endpointFromEnv(KIRO_OIDC_ENDPOINT_ENV, "https://oidc.{region}.amazonaws.com", region);
  const response = await kiroFetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...kiroSdkUserAgent("ssooidc", "E") },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: credentials.profileArn,
    startUrl: credentials.startUrl,
    isEnterprise: credentials.isEnterprise,
  };
}

/**
 * The preferred store's session, including an expired access token. No network.
 *
 * Registration reads the region off this so it can open that region's disk
 * cache. Refreshing stays on the request path ({@link resolveKiroCredentials}),
 * because a host awaits registration and must not block on a token call.
 */
export function readKiroSession(): KiroCredentials | undefined {
  try {
    const preferIde = resolveKiroAuthSource() === "ide";
    const preferred = preferIde
      ? (getKiroIdeCredentials() ?? getKiroIdeCredentialsAllowExpired())
      : (getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired());
    if (preferred) return preferred;
    return preferIde
      ? (getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired())
      : (getKiroIdeCredentials() ?? getKiroIdeCredentialsAllowExpired());
  } catch {
    return undefined;
  }
}

/**
 * Resolve a usable session from the stores this machine already has: the
 * kiro-cli database first, then the Kiro IDE's token file — or the reverse when
 * {@link KiroAuthSource} says so. The preferred store's own session is used or
 * refreshed before the other store's is consulted at all, because the two are
 * separate logins that can belong to different users of the same Kiro profile:
 * switching users just because the preferred token aged out bills whatever the
 * other account's quota happens to be. Expired material is accepted and
 * refreshed rather than rejected, because a refresh token outlives its access
 * token and rejecting here would ask the user to log in again for a session that
 * is still good.
 */
export async function resolveKiroCredentials(): Promise<KiroCredentials | undefined> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired } = await import("./kiro-cli.js");
  const stores =
    resolveKiroAuthSource() === "ide"
      ? [
          { fresh: getKiroIdeCredentials(), stale: getKiroIdeCredentialsAllowExpired() },
          { fresh: getKiroCliCredentials(), stale: getKiroCliCredentialsAllowExpired() },
        ]
      : [
          { fresh: getKiroCliCredentials(), stale: getKiroCliCredentialsAllowExpired() },
          { fresh: getKiroIdeCredentials(), stale: getKiroIdeCredentialsAllowExpired() },
        ];

  let lastFailure: unknown;
  for (const { fresh, stale } of stores) {
    if (fresh) return fresh;
    if (!stale) continue;
    try {
      return await refreshKiroToken(stale);
    } catch (error) {
      lastFailure = error;
      console.warn(`[kiro-core] Kiro session refresh failed: ${formatSafeError(error)}`);
    }
  }
  if (lastFailure) throw lastFailure;
  return undefined;
}

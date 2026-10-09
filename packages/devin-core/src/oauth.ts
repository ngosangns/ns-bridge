// ABOUTME: Devin credentials: PKCE OAuth login against app.devin.ai (runs in
// ABOUTME: the Go sidecar), and API-key sessions. Devin CLI tokens do not
// ABOUTME: expire by default, so there is no token refresh endpoint to call.

export type DevinAuthMethod = "oauth" | "apikey";

export interface DevinCredentials {
  /** Bearer token sent on every Cascade and management request. */
  access: string;
  /** Devin CLI tokens are long-lived and carry no refresh token of their own. */
  refresh: string;
  /** Epoch milliseconds; far-future for a token Devin does not expire. */
  expires: number;
  authMethod: DevinAuthMethod;
}

const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

export function isDevinApiKey(token: string): boolean {
  // Devin service-user / PAT tokens use the `cog_` prefix (API v3); a Cascade
  // session string carries no fixed prefix, so anything not shaped like a v3
  // token is treated as an opaque session string rather than rejected.
  return token.startsWith("cog_");
}

/** Decode a token's expiry from its JWT `exp` claim; a long fallback otherwise. */
function tokenExpiryMs(token: string): number {
  try {
    const [, payload] = token.split(".");
    if (payload) {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
        return decoded.exp * 1000 - 5 * 60 * 1000;
      }
    }
  } catch {
    // Malformed or non-JWT token; fall through to the long-lived default.
  }
  return Date.now() + FALLBACK_EXPIRES_MS;
}

export interface DevinLoginCallbacks {
  /** Open (or print) the URL the user must visit to approve the login. */
  onAuthUrl: (url: string, instructions?: string) => void;
  onProgress?: (message: string) => void;
  /** Milliseconds to wait for the browser round trip before giving up. */
  timeoutMs?: number;
}

/**
 * PKCE login against Devin's own CLI auth flow: the ns-bridge binary runs a
 * local HTTP server that receives the authorization code on
 * `127.0.0.1:59653/callback` and exchanges it for a bearer token — the flow
 * `devin auth login` runs. The callbacks are delivered through the sidecar's
 * host notifications.
 */
export async function loginDevinWithPkce(callbacks: DevinLoginCallbacks): Promise<DevinCredentials> {
  const { sidecarLogin } = await import("ns-bridge-core/sidecar");
  return sidecarLogin<DevinCredentials>(
    "devin",
    { timeoutMs: callbacks.timeoutMs ?? 5 * 60 * 1000 },
    {
      onAuthUrl: callbacks.onAuthUrl,
      ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
    },
  );
}

/** Wrap a raw token (OAuth session or API key) as a long-lived credential. */
export function credentialsFromToken(token: string): DevinCredentials {
  return {
    access: token,
    refresh: token,
    expires: isDevinApiKey(token) ? Date.now() + FALLBACK_EXPIRES_MS : tokenExpiryMs(token),
    authMethod: isDevinApiKey(token) ? "apikey" : "oauth",
  };
}

export function isExpired(credentials: DevinCredentials): boolean {
  return Date.now() >= credentials.expires;
}

/**
 * Devin CLI tokens do not expire by default (see docs: "do not expire by
 * default"), so there is no refresh endpoint — a token that stopped working was
 * revoked, not aged out, and the caller must prompt for a new login rather than
 * silently retrying a refresh call that does not exist upstream.
 */
export async function refreshDevinToken(credentials: DevinCredentials): Promise<DevinCredentials> {
  if (credentials.authMethod === "apikey") return credentials;
  if (!isExpired(credentials)) return credentials;
  throw new Error(
    "The Devin session has expired and Devin issues no refresh token. Sign in again with the OAuth login flow.",
  );
}

// ABOUTME: Devin (Cognition Cascade) wire constants shared with hosts: base
// ABOUTME: URLs and session-token framing. Wire requests themselves are built
// ABOUTME: in the Go vendor (go/internal/vendors/devin).

/** Base host for Devin's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

/** Base host for the Devin v3 management API (sessions, orgs — not used for chat). */
export const DEVIN_MANAGEMENT_BASE_URL = "https://api.devin.ai";

/** Base host for the Devin web app, used for the OAuth PKCE login page. */
export const DEVIN_WEBAPP_URL = "https://app.devin.ai";

export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

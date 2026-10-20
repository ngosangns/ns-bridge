// ABOUTME: Failures of the Grok CLI-session Responses client.
// ABOUTME: Messages stay free of tokens, refresh tokens, and account ids.

/** The user has no Grok CLI login, or the saved session can no longer be refreshed. */
export const GROK_LOGIN_MESSAGE = "Grok CLI is not signed in. Run `grok login`.";

export class GrokAuthError extends Error {
  constructor(message = GROK_LOGIN_MESSAGE) {
    super(message);
    this.name = "GrokAuthError";
  }
}

/** HTTP or stream failure from cli-chat-proxy. `status` is the HTTP status when there was one. */
export class GrokApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GrokApiError";
    this.status = status;
  }
}

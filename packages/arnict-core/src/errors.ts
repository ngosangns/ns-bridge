// ABOUTME: Failures of the Arnict chat-completions client.
// ABOUTME: Messages stay free of API keys.

/** The user has no Arnict API key on file. */
export const ARNICT_LOGIN_MESSAGE = "Arnict API key not found. Set ARNICT_API_KEY or run `ns-bridge arnict login`.";

export class ArnictAuthError extends Error {
  constructor(message = ARNICT_LOGIN_MESSAGE) {
    super(message);
    this.name = "ArnictAuthError";
  }
}

/** HTTP failure from api.arnict.com. `status` is the HTTP status when there was one. */
export class ArnictApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ArnictApiError";
    this.status = status;
    this.code = code;
  }
}

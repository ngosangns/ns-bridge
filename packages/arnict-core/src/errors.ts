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

/**
 * The `{error: {message, type, code, param}}` body arnict.com/docs/errors documents,
 * read off a failed response. The message carries the status, the code, and the
 * `x-request-id` header; `Bearer ...` is redacted so a echoed header cannot leak the key.
 */
export async function arnictApiErrorFromResponse(response: Response): Promise<ArnictApiError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let message = "";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; type?: string; code?: string; param?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") {
      message = parsed.error;
    } else if (parsed.error) {
      message = parsed.error.message ?? parsed.error.type ?? "";
      code = parsed.error.code;
      if (parsed.error.param) message += ` (param: ${parsed.error.param})`;
    } else {
      message = parsed.message ?? "";
    }
  } catch {
    message = "";
  }
  const redacted = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
  const body = redacted || text.replace(/\s+/g, " ").trim().slice(0, 300) || "no response body";
  const requestId = response.headers.get("x-request-id")?.trim();
  return new ArnictApiError(
    `Arnict error (${response.status}${code ? ` ${code}` : ""}): ${body}${requestId ? ` [request id: ${requestId}]` : ""}`,
    response.status,
    code,
  );
}

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

const BEARER_PATTERN = /Bearer\s+\S+/gi;

/** Masks `Bearer <token>` and every occurrence of the raw key so nothing secret reaches an error message. */
function redact(text: string, apiKey?: string): string {
  let out = text.replace(BEARER_PATTERN, "Bearer [redacted]");
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("[redacted]");
  return out;
}

/**
 * The `{error: {message, type, code, param}}` body arnict.com/docs/errors documents,
 * read off a failed response. The message carries the status, the code, and the
 * `x-request-id` header; `Bearer ...` and the raw key are redacted from every
 * body-derived string so an echoed header or body cannot leak the key.
 */
export async function arnictApiErrorFromResponse(response: Response, apiKey?: string): Promise<ArnictApiError> {
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
  const redactedMessage = redact(message, apiKey).slice(0, 300);
  const body = redactedMessage || redact(text, apiKey).replace(/\s+/g, " ").trim().slice(0, 300) || "no response body";
  const requestId = redact(response.headers.get("x-request-id")?.trim() ?? "", apiKey);
  const codeSuffix = code ? ` ${redact(code, apiKey)}` : "";
  return new ArnictApiError(
    `Arnict error (${response.status}${codeSuffix}): ${body}${requestId ? ` [request id: ${requestId}]` : ""}`,
    response.status,
    code,
  );
}

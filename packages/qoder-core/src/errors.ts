// ABOUTME: Failures from the Qoder SDK / qodercli integration.

export const QODER_LOGIN_MESSAGE = "No Qoder session found. Run `qodercli login`, or set QODER_PERSONAL_ACCESS_TOKEN.";

export class QoderAuthError extends Error {
  constructor(message = QODER_LOGIN_MESSAGE) {
    super(message);
    this.name = "QoderAuthError";
  }
}

export class QoderApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "QoderApiError";
    this.code = code;
  }
}

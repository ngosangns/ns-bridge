// ABOUTME: Error text that is safe to show a user or write to a transcript.

const SECRET_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=$-]{12,}/gi,
  /\b(ksk_|devin-session-token\$|sk-)[A-Za-z0-9._~+/=$-]{8,}/g,
];

/** Stringify any thrown value, with obvious credentials redacted. */
export function formatErrorMessage(error: unknown): string {
  let text = error instanceof Error ? error.message || error.name : String(error);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix: string | undefined) => `${prefix ?? ""}[redacted]`);
  }
  return text;
}

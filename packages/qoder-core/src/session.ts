// ABOUTME: Maps a host session id onto the UUID the Qoder SDK accepts.

import { createHash } from "node:crypto";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Qoder rejects any session id that is not a UUID (`session-<uuid>` from the
 * DeepSeek Harness, for one). Hosts rarely hand out a bare UUID, so take the
 * one they embed, and otherwise derive a stable UUID from the id rather than
 * dropping the mapping.
 */
export function qoderSessionId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const embedded = UUID.exec(value)?.[0];
  if (embedded) return embedded.toLowerCase();
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ABOUTME: Headers the CLI chat proxy requires, including the client version it uses to reject old builds.
// ABOUTME: The version comes from the CLI's own cache so a later floor bump does not 426 a hardcoded build.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Installed grok-native the 2026-10-20 proxy accepted. Overridden by the cache or env. */
export const FALLBACK_GROK_CLIENT_VERSION = "1.0.62";

export const DEFAULT_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

export function grokProxyBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim() || DEFAULT_PROXY_BASE).replace(/\/$/, "");
}

export async function resolveGrokClientVersion(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cachePath?: string;
}): Promise<string> {
  const env = options?.env ?? process.env;
  const fromEnv = env.GROK_CLIENT_VERSION?.trim();
  if (fromEnv) return fromEnv;
  const path = options?.cachePath ?? join(options?.home ?? homedir(), ".grok", "models_cache.json");
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as { grok_version?: string };
    const version = json.grok_version?.trim();
    if (version) return version;
  } catch {
    // A missing catalog still has the fallback the proxy accepted.
  }
  return FALLBACK_GROK_CLIENT_VERSION;
}

export function grokResponseHeaders(input: {
  accessToken: string;
  clientVersion: string;
  modelId: string;
  /** Routes the request to the server holding this conversation's prompt cache. */
  conversationId?: string;
}): Record<string, string> {
  const conversationId = input.conversationId?.trim();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": input.clientVersion,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "xai-grok-cli",
    "User-Agent": `grok-cli/${input.clientVersion}`,
    "x-grok-model-override": input.modelId,
    ...(conversationId ? { "x-grok-conv-id": conversationId } : {}),
  };
}

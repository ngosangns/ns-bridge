// ABOUTME: The one place kiro-core opens an HTTP connection.
// ABOUTME: Every fetch in this package goes through `kiroFetch`, and every User-Agent it sends is named here.

import { kiroAuthHeaders, kiroTokenTypeHeaders } from "./token-type.js";

/**
 * The User-Agent strings this package sends, one per endpoint family.
 *
 * These are not interchangeable. Kiro's edges classify the caller from the
 * header and answer differently — the runtime stream only speaks event-stream
 * to a CLI-shaped agent, the desktop refresh endpoint expects the desktop app,
 * the AWS SDK-shaped calls carry the SDK invocation headers alongside the
 * agent string. So the policy is a table, not a single constant: each call
 * site names which row it is, and nothing else in the package writes the header.
 */
export const KIRO_USER_AGENTS = {
  /** REST-style management calls (ListAvailableProfiles, ListAvailableModels, GetUsageLimits). */
  management: "ns-kiro-provider",
  /** `prod.{region}.auth.desktop.kiro.dev/refreshToken` — the desktop app's own refresh. */
  desktop: "Kiro-Desktop/0.2.13 (darwin; arm64)",
  /** A customer's own OIDC token endpoint. No vendor to impersonate, so this names the package. */
  externalIdp: "kiro-core",
} as const;

/**
 * The AWS SDK user-agent plus the invocation headers the SDK always sends with
 * it. Used by the two SDK-shaped calls: GetProfile and the SSO OIDC refresh.
 */
export function kiroSdkUserAgent(service: string, sdkVersion: string): Record<string, string> {
  return {
    "User-Agent": `aws-sdk-js/3.714.0 os/macos/24.3.0 lang/js md/nodejs/22.14.0 api/${service}/3.714.0 exec-env/kiro-cli/2.7.0 m/E`,
    "amz-sdk-invocation-id": "00000000-0000-0000-0000-000000000000",
    "amz-sdk-request": `attempt=1; max=${sdkVersion}`,
  };
}

/**
 * The user-agent the runtime streaming edge expects, on both header casings.
 *
 * `mid` is a fresh id per attempt: the CLI embeds one, and a retried request
 * that reused it would look like a replay of the attempt that just failed.
 */
export function kiroRuntimeUserAgent(mid: string): Record<string, string> {
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
  return { "x-amz-user-agent": ua, "user-agent": ua };
}

export interface KiroFetchInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

/** One fetch. The only `fetch` call in this package. */
export function kiroFetch(url: string, init?: KiroFetchInit): Promise<Response> {
  return fetch(url, init);
}

/**
 * A REST management call: bearer auth, the token-type header, and the
 * management user-agent. GET calls carry the body as query parameters.
 */
export async function kiroManagementFetch(
  url: URL,
  auth: { accessToken: string },
  method: "GET" | "POST",
  body: object,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...kiroAuthHeaders(auth.accessToken),
    ...kiroTokenTypeHeaders(auth.accessToken),
    "User-Agent": KIRO_USER_AGENTS.management,
  };
  const init: KiroFetchInit = { method, headers };
  if (method === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  } else {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return kiroFetch(url.toString(), init);
}

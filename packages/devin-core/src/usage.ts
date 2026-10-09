// ABOUTME: Account plan + credit usage via SeatManagementService/GetUserStatus —
// ABOUTME: the single RPC the native CLI issues for quota display at startup.
// ABOUTME: The RPC and report shaping run in the Go vendor; this facade keeps
// ABOUTME: the neutral types and the fail-soft contract.

export type DevinUsageUnit = "credits" | "percent" | "unknown";
export type DevinUsageWindowId = "monthly" | "daily" | "weekly";

/** One normalized quota line item, host-agnostic. */
export interface DevinUsageLimit {
  id: string;
  label: string;
  window: DevinUsageWindowId;
  used: number;
  /** Monthly grant; absent for percent windows and zero-grant buckets. */
  limit?: number;
  remaining: number;
  unit: DevinUsageUnit;
  /** 0..1 when a grant exists. */
  usedFraction?: number;
  resetsAt?: number;
}

/** Plan/account facts a host may display beside the quota list. */
export interface DevinProviderUsage {
  email?: string;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  planName?: string;
  /** Epoch ms the billing cycle ends. */
  planEnd?: number;
  overageBalanceUsd?: number;
  limits: DevinUsageLimit[];
  /**
   * The raw `GetUserStatusResponse` protobuf body, base64 — retained for
   * hosts that want fields the report did not map.
   */
  raw: string;
}

export interface DevinUsageFetchOptions {
  /**
   * Session token; the wire format's `devin-session-token$` prefix is added.
   * A raw legacy Windsurf Enterprise key is retried as-is after a 401.
   */
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Fetch the account's plan + credit usage. Returns `null` on request/decode
 * failure — the usage panel is advisory and must not surface as an outage.
 */
export async function fetchDevinUsage(options: DevinUsageFetchOptions): Promise<DevinProviderUsage | null> {
  if (!options.apiKey?.trim()) return null;
  const { runDevinOp } = await import("./engine-ops.js");
  return runDevinOp<DevinProviderUsage | null, DevinUsageWire | null>({
    op: "usage",
    request: () => ({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    }),
    fromWire: devinUsageFromWire,
    fallback: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** The sidecar's `usage` result: the report plus the raw response body. */
interface DevinUsageWire {
  report: Omit<DevinProviderUsage, "raw">;
  /** Base64 GetUserStatusResponse bytes. */
  raw: string;
}

function devinUsageFromWire(wire: DevinUsageWire | null): DevinProviderUsage | null {
  if (!wire || typeof wire.raw !== "string") return null;
  return { ...wire.report, raw: wire.raw };
}

// Minimal ambient declarations so `tsc` does not need OMP installed.
// At build time these specifiers stay external and OMP's extension loader
// resolves them to its in-process modules.
declare module "@oh-my-pi/pi-ai" {
  export function createAssistantMessageEventStream(): unknown;

  export type UsageUnit = "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";

  export interface UsageCredential {
    type: "api_key" | "oauth";
    apiKey?: string;
    accessToken?: string;
    expiresAt?: number;
  }

  export interface UsageFetchParams {
    provider: string;
    credential: UsageCredential;
  }

  export interface UsageFetchContext {
    fetch: typeof fetch;
  }

  export interface UsageReport {
    provider: string;
    fetchedAt: number;
    limits: UsageLimit[];
    notes?: string[];
    metadata?: Record<string, unknown>;
    raw?: unknown;
  }

  export interface UsageLimit {
    id: string;
    label: string;
    scope: { provider: string; tier?: string };
    window?: { id: string; label: string; resetsAt?: number };
    amount: { used: number; limit?: number; unit: UsageUnit };
    status?: "exhausted" | "ok" | "unknown" | "warning";
    notes?: string[];
  }

  export interface UsageProvider {
    id: string;
    fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;
    validatesCredentials?: boolean;
  }
}

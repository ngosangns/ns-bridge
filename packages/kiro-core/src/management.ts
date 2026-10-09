// ABOUTME: Shared state for the Kiro management control plane: the profile
// ABOUTME: ARN/region caches this process carries across sidecar calls, plus
// ABOUTME: the error class management failures rebuild into. The RPCs
// ABOUTME: themselves (ListAvailableProfiles, ListAvailableModels,
// ABOUTME: GetUsageLimits, GetProfile) run in go/internal/vendors/kiro.

import { createHash } from "node:crypto";

export interface KiroManagementAuth {
  accessToken: string;
  region: string;
}

export interface KiroCatalogModel {
  modelId: string;
  tokenLimits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface KiroListAvailableModelsResponse {
  models: KiroCatalogModel[];
  [key: string]: unknown;
}

export interface KiroGetUsageLimitsRequest {
  profileArn?: string;
  origin: "KIRO_CLI";
  resourceType: "CREDIT";
  isEmailRequired: false;
}

const profileArnCache = new Map<string, string>();
const pendingProfileRequests = new Map<string, Promise<string>>();
/**
 * Region where the token actually has a profile, keyed like profileArnCache.
 * Populated when a sidecar call finds the ARN on a non-primary region so
 * callers can route profile-dependent management calls (ListAvailableModels) to
 * the same region where the profile exists.
 */
const profileRegionCache = new Map<string, string>();

export class KiroManagementHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KiroManagementHttpError";
  }
}

export function resetKiroProfileArnCache(): void {
  profileArnCache.clear();
  profileRegionCache.clear();
  pendingProfileRequests.clear();
}

/**
 * The resolved profile ARNs this process holds, keyed like the internal cache.
 * The Go sidecar runs one turn per process, so the facade seeds it with these.
 */
export function snapshotKiroProfileArnCache(): Record<string, string> {
  return Object.fromEntries(profileArnCache);
}

/** The regions resolved profiles live in, keyed like the ARN cache. */
export function snapshotKiroProfileRegionCache(): Record<string, string> {
  return Object.fromEntries(profileRegionCache);
}

/** Fold back the profile regions a sidecar operation resolved. */
export function applyKiroProfileRegionChanges(regions: Record<string, string> | undefined): void {
  if (!regions) return;
  for (const [key, region] of Object.entries(regions))
    if (typeof region === "string" && region) profileRegionCache.set(key, region);
}

/**
 * Fold back what a sidecar turn learned: an ARN it resolved, or `null` for an
 * entry it invalidated after a 403.
 */
export function applyKiroProfileArnCacheChanges(changes: Record<string, string | null> | undefined): void {
  if (!changes) return;
  for (const [key, arn] of Object.entries(changes)) {
    if (typeof arn === "string" && arn) {
      profileArnCache.set(key, arn);
    } else {
      profileArnCache.delete(key);
      profileRegionCache.delete(key);
      pendingProfileRequests.delete(key);
    }
  }
}

function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash("sha256").update(auth.accessToken).digest("base64url");
  return `${auth.region}:${tokenHash}`;
}

/** Drop one token's resolved profile ARN so the next call re-resolves it. */
export function invalidateKiroProfileArn(auth: KiroManagementAuth): void {
  const key = profileCacheKey(auth);
  profileArnCache.delete(key);
  profileRegionCache.delete(key);
  pendingProfileRequests.delete(key);
}

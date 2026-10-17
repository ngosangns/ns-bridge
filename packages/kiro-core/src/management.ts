// ABOUTME: The error class management failures rebuild into, plus the sync
// ABOUTME: helpers that edit the profile-ARN file the Go sidecar owns
// ABOUTME: (~/.ns-kiro-provider-process-state.json). The RPCs themselves
// ABOUTME: (ListAvailableProfiles, ListAvailableModels, GetUsageLimits,
// ABOUTME: GetProfile) run in go/internal/vendors/kiro.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
/**
 * Region where the token actually has a profile, keyed like profileArnCache.
 * The binary's process-state file is the copy the next call reads. These maps
 * stay so a caller that still snapshots them, and the sync reset/invalidate
 * helpers, see the same edit.
 */
const profileRegionCache = new Map<string, string>();

interface ProcessStateFile {
  profileArns?: Record<string, string>;
  profileRegions?: Record<string, string>;
  [key: string]: unknown;
}

/** Same path the binary uses (KIRO_PROCESS_STATE_PATH, or the home file). */
function processStatePath(): string | undefined {
  const override = process.env.KIRO_PROCESS_STATE_PATH;
  if (override === "off") return undefined;
  if (override) return override;
  const home = homedir();
  return home ? join(home, ".ns-kiro-provider-process-state.json") : undefined;
}

/** Edit the profile section of the process-state file, leaving estimates alone. */
function editProcessState(edit: (state: ProcessStateFile) => void): void {
  const path = processStatePath();
  if (!path || !existsSync(path)) return;
  let state: ProcessStateFile = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as ProcessStateFile;
  } catch {
    return;
  }
  if (!state.profileArns || typeof state.profileArns !== "object") state.profileArns = {};
  if (!state.profileRegions || typeof state.profileRegions !== "object") state.profileRegions = {};
  edit(state);
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // The binary rewrites this file under its own lock. A failed local edit
    // only affects the sync helpers, which run between calls.
  }
}

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
  editProcessState((state) => {
    state.profileArns = {};
    state.profileRegions = {};
  });
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
  editProcessState((state) => {
    delete state.profileArns?.[key];
    delete state.profileRegions?.[key];
  });
}

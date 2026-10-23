// ABOUTME: Which Kiro profile this machine runs on when one login can use several.
// ABOUTME: Keeps the user's pick in ~/.ns-bridge/kiro-profile.json, below the KIRO_PROFILE_ARN override.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Written by `ns-bridge kiro profile use`, read on every profile resolution so
 * a running host follows a switch on its next request without a restart.
 */
export const KIRO_PROFILE_SELECTION_PATH = join(homedir(), ".ns-bridge", "kiro-profile.json");

/**
 * Explicit user override for which Kiro profile to resolve/use. When set, it
 * wins over the saved pick and any token-carried or network-discovered
 * profile, fixing #110's "wrong profile picked among several -> reduced model
 * catalog" for users who have multiple profiles and know which one they want.
 */
export const KIRO_PROFILE_ARN_ENV = "KIRO_PROFILE_ARN";

export interface KiroProfileSelection {
  arn: string;
  name?: string;
}

export type KiroProfileOverrideSource = "env" | "ns-bridge";

/** The profile the user pinned, if any, and where the pin came from. */
export interface KiroProfileOverride {
  arn: string;
  source: KiroProfileOverrideSource;
}

export function readKiroProfileSelection(): KiroProfileSelection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(KIRO_PROFILE_SELECTION_PATH, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { arn, name } = value as { arn?: unknown; name?: unknown };
  if (typeof arn !== "string" || !arn) return undefined;
  return { arn, ...(typeof name === "string" && name ? { name } : {}) };
}

/** Save the pick, or remove it with `undefined` so the login's own profile applies again. */
export function writeKiroProfileSelection(selection: KiroProfileSelection | undefined): void {
  if (!selection) {
    rmSync(KIRO_PROFILE_SELECTION_PATH, { force: true });
    return;
  }
  mkdirSync(dirname(KIRO_PROFILE_SELECTION_PATH), { recursive: true });
  const temporaryPath = `${KIRO_PROFILE_SELECTION_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(selection, null, 2)}\n`, "utf-8");
    renameSync(temporaryPath, KIRO_PROFILE_SELECTION_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** KIRO_PROFILE_ARN first, then the saved pick. Neither means the login decides. */
export function getKiroProfileOverride(): KiroProfileOverride | undefined {
  const envArn = process.env[KIRO_PROFILE_ARN_ENV]?.trim();
  if (envArn) return { arn: envArn, source: "env" };
  const selection = readKiroProfileSelection();
  return selection ? { arn: selection.arn, source: "ns-bridge" } : undefined;
}

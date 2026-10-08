// ABOUTME: Projects a vendor catalog entry's effort ladder onto the two Pi-family model shapes.

import { BRIDGE_EFFORT_ORDER, type BridgeEffort } from "../types.js";

/**
 * Pi 1.x: `thinkingLevelMap` maps each Pi level to a provider value, `null`
 * marking a level the model does not support. Levels the vendor exposes map to
 * themselves (the cores translate them to wire values); `off` is left to the
 * provider default. Undefined when the model has no effort control.
 */
export function toPiThinkingLevelMap(
  efforts: readonly BridgeEffort[] | undefined,
): Partial<Record<"off" | BridgeEffort, string | null>> | undefined {
  if (!efforts?.length) return undefined;
  const supported = new Set(efforts);
  const map: Partial<Record<"off" | BridgeEffort, string | null>> = {};
  for (const level of BRIDGE_EFFORT_ORDER) map[level] = supported.has(level) ? level : null;
  return map;
}

/** OMP: `thinking: { mode: "effort", efforts }`. Undefined when the model has no effort control. */
export function toOmpThinking(
  efforts: readonly BridgeEffort[] | undefined,
  options: { supportsDisplay?: boolean } = {},
): { mode: "effort"; efforts: BridgeEffort[]; supportsDisplay?: boolean } | undefined {
  if (!efforts?.length) return undefined;
  return { mode: "effort", efforts: [...efforts], ...(options.supportsDisplay ? { supportsDisplay: true } : {}) };
}

const EFFORTS: ReadonlySet<string> = new Set(BRIDGE_EFFORT_ORDER);

/** Narrow a host's reasoning option to a neutral effort; anything else (incl. `off`) means none. */
export function toBridgeEffort(reasoning: unknown): BridgeEffort | undefined {
  return typeof reasoning === "string" && EFFORTS.has(reasoning) ? (reasoning as BridgeEffort) : undefined;
}

import { BRIDGE_EFFORT_ORDER, type BridgeEffort } from "./types.js";

const EFFORTS: Record<string, true> = {};
for (const level of BRIDGE_EFFORT_ORDER) EFFORTS[level] = true;

/** Narrow a host's reasoning option to a neutral effort. Anything else, including `off`, means none. */
export function toBridgeEffort(reasoning: unknown): BridgeEffort | undefined {
  return typeof reasoning === "string" && EFFORTS[reasoning] === true ? (reasoning as BridgeEffort) : undefined;
}

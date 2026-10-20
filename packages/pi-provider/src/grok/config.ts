// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS, GROK_DEFAULT_MODEL_ID } from "ns-grok-core";
import type { ReasoningEffort } from "ns-grok-core/agent";

/** Pi provider id (registered as grok-sdk/<model>). */
export const PROVIDER = "grok-sdk";
export const API = "grok-sdk";
/** Legacy provider id from pi-grok-agent-cli — still accepted for aliases. */
export const LEGACY_PROVIDER = "grok-agent-cli";
/** The core owns which id is the CLI's default. */
export const DEFAULT_MODEL_ID = GROK_DEFAULT_MODEL_ID;
export const CLIENT_NAME = "pi-grok-sdk";
export const CLIENT_VERSION = "0.2.1";

/** Map pi thinking levels onto Grok `--reasoning-effort` values. */
export const THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

// The catalog defaults are the core's, so the Pi catalog and the Harness
// catalog cannot disagree about a model the file does not describe.
export const DEFAULT_CONTEXT_WINDOW = GROK_DEFAULT_CONTEXT_WINDOW;
export const DEFAULT_MAX_TOKENS = GROK_DEFAULT_MAX_TOKENS;

export function mapReasoningEffort(
	reasoning: string | undefined,
): ReasoningEffort | undefined {
	if (!reasoning) return undefined;
	const normalized = reasoning.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (
		normalized === "none" ||
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh" ||
		normalized === "max"
	) {
		return normalized;
	}
	return undefined;
}

// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS } from "ns-grok-core";

/** Pi api id the assistant message carries when the host gives none. */
export const API = "grok-cli";
export const CLIENT_NAME = "ns-pi-provider";
export const CLIENT_VERSION = "0.5.3";

/** Map pi thinking levels onto Grok reasoning effort values. */
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

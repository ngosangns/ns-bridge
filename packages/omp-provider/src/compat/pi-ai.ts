/**
 * Build-time replacement for `@earendil-works/pi-ai` and
 * `@earendil-works/pi-ai/compat` inside the bundled ns-pi-provider sources.
 *
 * Deliberately NOT `export *`: listing every runtime symbol lets esbuild fail
 * the build when ns-pi-provider starts importing something OMP lacks, instead
 * of OMP failing at extension load ("Export named ... not found").
 */
export { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
export { calculateCost } from "./cost.js";
export { getCurrentSystemPrompt, getCurrentTools, withoutInitialSystemMessage } from "./transcript.js";

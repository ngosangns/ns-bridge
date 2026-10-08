/**
 * Pi 1.x transcript helpers that OMP's pi-ai does not ship, for the bundled
 * ns-pi-provider sources. One implementation shared with every Pi-family host:
 * ns-bridge-core/pi. On OMP (no `system` messages in the transcript) they
 * resolve to "" / [] / the messages unchanged.
 */
export { getCurrentSystemPrompt, getCurrentTools, withoutInitialSystemMessage } from "ns-bridge-core/pi";

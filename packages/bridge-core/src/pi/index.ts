// Pi-family host bridge: Pi 1.x (@earendil-works/pi-ai) and OMP (@oh-my-pi/pi-ai)
// share an extension surface and an assistant-message event protocol, so one
// bridge serves both. Nothing here imports either host; shapes are structural.

export {
  type PiContextLike,
  type PiMessageLike,
  type PiToolDefinitionLike,
  resolveSystemPrompt,
  resolveTools,
  toBridgeContext,
  toBridgeMessages,
  toBridgeTools,
} from "./context.js";
export { toBridgeEffort, toOmpThinking, toPiThinkingLevelMap } from "./models.js";
export {
  applyBridgeUsage,
  type PiAssistantMessageLike,
  type PiEventStreamLike,
  type PiModelLike,
  type PiStreamOptions,
  streamToPi,
  zeroPiUsage,
} from "./stream.js";
export { getCurrentSystemPrompt, getCurrentTools, type PiToolLike, withoutInitialSystemMessage } from "./transcript.js";

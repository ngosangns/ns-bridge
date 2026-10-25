// Anthropic Messages host bridge: what the local HTTP server ZCode (@ai-sdk/anthropic)
// talks to projects through. Nothing here imports a host; shapes are structural.

export {
  type AnthropicBase64ImageSource,
  type AnthropicContentBlock,
  type AnthropicImageBlock,
  type AnthropicImageSource,
  type AnthropicMessage,
  type AnthropicOutputConfig,
  type AnthropicRedactedThinkingBlock,
  type AnthropicRequestBody,
  type AnthropicRequestResult,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicThinkingConfig,
  type AnthropicToolDefinition,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUrlImageSource,
  type BridgeRequestFromAnthropic,
  toBridgeRequest,
} from "./request.js";
export {
  type AnthropicBackend,
  type AnthropicServerOptions,
  createAnthropicServer,
} from "./server.js";
export {
  type AnthropicStreamOptions,
  anthropicError,
  collectAnthropicMessage,
  toAnthropicSse,
} from "./stream.js";

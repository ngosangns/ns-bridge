// DeepSeek Harness host bridge, shared by every ns-dsh-llm-* adapter.
// Needs @deepseek-ai/dsh-llm at runtime (an optional peer: the Harness provides it).

export {
  compactionReserveTokens,
  createDshLlmAdapter,
  type DshAdapterModel,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "./adapter.js";
export { type MessageProjectionContext, toBridgeMessagesFromDsh } from "./messages.js";
export { streamToDsh, toDshUsage } from "./stream.js";

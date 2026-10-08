// DeepSeek Harness host bridge, shared by ns-dsh-llm-kiro and ns-dsh-llm-devin.
// Needs @deepseek-ai/dsh-llm at runtime (an optional peer: the Harness provides it).

export { type MessageProjectionContext, toBridgeMessagesFromDsh } from "./messages.js";
export { streamToDsh, toDshUsage } from "./stream.js";

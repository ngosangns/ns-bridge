// Public surface of ns-bridge-core: the neutral vocabulary. Host bridges live
// under subpaths so a host only loads what it speaks:
//   ns-bridge-core/pi   Pi (@earendil-works/pi-ai) and OMP (@oh-my-pi/pi-ai)
//   ns-bridge-core/dsh  DeepSeek Harness (@deepseek-ai/dsh-llm)

export { formatErrorMessage } from "./errors.js";
export * from "./types.js";

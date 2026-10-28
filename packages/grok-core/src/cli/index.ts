// ABOUTME: The Grok CLI's model list: discovery and id mapping.
// ABOUTME: Host-neutral. A host supplies its own cache directory and provider-model shape.

export { getGrokVersion, probeGrokAuth, resolveGrokBinary } from "./binary.js";
export { discoverGrokModels, type GrokCacheInfo, grokModelInfoFromCache, parseGrokModelsOutput } from "./models.js";
export type { GrokModelDescriptor } from "./types.js";

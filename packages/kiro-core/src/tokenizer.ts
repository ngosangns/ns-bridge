// ABOUTME: Token counting using js-tiktoken with lazy-loaded cl100k_base encoding.
// ABOUTME: The rank table loads on the first count, not when a host imports this package.

import { createRequire } from "node:module";
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";

// Deliberately not `encodingForModel` from the package root: that entry point
// embeds every encoding's BPE ranks, which is 5.6 MB in a bundled extension.
// Only cl100k_base is ever used here — it is what `gpt-4` resolves to.
// A static import evaluates that 1 MB table while Pi, OMP, and DSH are still
// starting. The count runs later, and only when a response omits outputTokens.
const require = createRequire(import.meta.url);
let encoder: Tiktoken | null = null;

function loadRanks(): TiktokenBPE {
  const loaded = require("js-tiktoken/ranks/cl100k_base") as TiktokenBPE & { default?: TiktokenBPE };
  return loaded.default ?? loaded;
}

function getEncoder(): Tiktoken {
  if (!encoder) encoder = new Tiktoken(loadRanks());
  return encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

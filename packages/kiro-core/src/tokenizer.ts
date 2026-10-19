// ABOUTME: Token counting using js-tiktoken with lazy-loaded cl100k_base encoding.
// ABOUTME: The rank table loads on the first count, not when a host imports this package.

import { createRequire } from "node:module";
import type { Tiktoken, TiktokenBPE } from "js-tiktoken/lite";

// Deliberately not `encodingForModel` from the package root: that entry point
// embeds every encoding's BPE ranks, which is 5.6 MB in a bundled extension.
// Only cl100k_base is ever used here — it is what `gpt-4` resolves to.
// Neither the lite encoder nor the rank table is evaluated at import. The
// count runs later, and only when a response omits outputTokens.
const require = createRequire(import.meta.url);
let encoder: Tiktoken | null = null;

function loadRanks(): TiktokenBPE {
  const loaded = require("js-tiktoken/ranks/cl100k_base") as TiktokenBPE & { default?: TiktokenBPE };
  return loaded.default ?? loaded;
}

function loadTiktoken(): new (ranks: TiktokenBPE) => Tiktoken {
  const loaded = require("js-tiktoken/lite") as { Tiktoken: new (ranks: TiktokenBPE) => Tiktoken };
  return loaded.Tiktoken;
}

function getEncoder(): Tiktoken {
  if (!encoder) encoder = new (loadTiktoken())(loadRanks());
  return encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

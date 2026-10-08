#!/usr/bin/env node
// Regenerates go/internal/tiktoken's embedded cl100k_base ranks (and the
// parity fixture its tests compare against) from the js-tiktoken that
// ns-kiro-core counts tokens with, so both engines count the same way.
//
//   node scripts/gen-tiktoken-ranks.mjs
//
// Ranks file: gzip("TKN1", uint32 BE count, then per rank a uvarint byte
// length and the token bytes). Ranks are contiguous from 0.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/kiro-core/package.json"));
const { Tiktoken } = await import(require.resolve("js-tiktoken/lite"));
const cl100k = (await import(require.resolve("js-tiktoken/ranks/cl100k_base"))).default;

const ranks = new Map();
for (const line of cl100k.bpe_ranks.split("\n").filter(Boolean)) {
  const [, offsetStr, ...tokens] = line.split(" ");
  const offset = Number.parseInt(offsetStr, 10);
  tokens.forEach((token, i) => ranks.set(offset + i, Buffer.from(token, "base64")));
}
const count = Math.max(...ranks.keys()) + 1;
if (ranks.size !== count) throw new Error(`ranks are not contiguous: ${ranks.size} of ${count}`);

const parts = [Buffer.from("TKN1"), Buffer.alloc(4)];
parts[1].writeUInt32BE(count);
for (let rank = 0; rank < count; rank++) {
  const bytes = ranks.get(rank);
  let n = bytes.length;
  const varint = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    varint.push(b);
  } while (n);
  parts.push(Buffer.from(varint), bytes);
}
const outDir = join(root, "go/internal/tiktoken");
writeFileSync(join(outDir, "cl100k_base.tkn.gz"), gzipSync(Buffer.concat(parts), { level: 9 }));

// Parity fixture: token counts js-tiktoken gives for awkward inputs.
const enc = new Tiktoken(cl100k);
const samples = [
  "",
  "hello world",
  "Hello, World! It's a test. We'll see; they'd've DONE it'S",
  "  leading and trailing spaces   ",
  "tabs\tand\nnewlines\r\n\r\nmixed \n \n  end\n",
  "numbers 1234567 3.14159 -42 1e10 007",
  "unicode: héllo wörld naïve café — “quotes” 日本語のテキスト 한국어 العربية",
  "emoji 😀👍🏽 family 👨‍👩‍👧 flags 🇻🇳",
  "code: function f(x) { return x * 2; } // comment\n\tconst y = [1, 2, 3];",
  "symbols !!! ??? ... --- === +++ ***\n\n",
  "<thinking>I should call the tool</thinking>\n\n{\"path\":\"/tmp/a.txt\",\"content\":\"x\"}",
  "   \n\n\n   ",
  "a\u00a0b\u2003c\u3000d\ufeffe",
  "mixed123abc456def 12 345 6789",
  "'s 'S 't 're 'RE 've 'll 'd 'm 'x",
  "end with spaces    ",
  "x".repeat(300),
  "The quick brown fox jumps over the lazy dog. ".repeat(20),
];
const fixture = samples.map((text) => ({ text, count: text.length === 0 ? 0 : enc.encode(text).length }));
writeFileSync(join(outDir, "testdata/counts.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${count} ranks and ${fixture.length} fixture counts`);

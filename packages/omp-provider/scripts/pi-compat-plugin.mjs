/**
 * Shared esbuild plugin for every bundle that compiles Pi sources for OMP:
 * `ns-omp-provider` itself, and the CLI's prebuilt OMP host bundle.
 *
 * - `@earendil-works/pi-ai` and `/compat`  → src/compat/pi-ai.ts
 * - `@earendil-works/pi-ai/oauth`           → src/compat/pi-ai-oauth.ts
 * - `@earendil-works/pi-coding-agent`       → src/compat/pi-coding-agent.ts (types only)
 *
 * Any other Pi specifier is a hard build error, so an ns-pi-provider upgrade
 * that needs a new shim fails here rather than at OMP load time.
 */
import { resolve } from "node:path";

export function createPiCompatPlugin(ompRoot) {
  const compat = (file) => resolve(ompRoot, "src/compat", file);
  const aliases = new Map([
    ["@earendil-works/pi-ai", compat("pi-ai.ts")],
    ["@earendil-works/pi-ai/compat", compat("pi-ai.ts")],
    ["@earendil-works/pi-ai/oauth", compat("pi-ai-oauth.ts")],
    ["@earendil-works/pi-coding-agent", compat("pi-coding-agent.ts")],
  ]);

  return {
    name: "pi-to-omp-compat",
    setup(b) {
      b.onResolve({ filter: /^@(earendil-works|mariozechner)\/pi-/ }, (args) => {
        const target = aliases.get(args.path.replace(/^@mariozechner\//, "@earendil-works/"));
        if (target) return { path: target };
        return {
          errors: [
            {
              text: `no OMP compat shim for "${args.path}" (imported from ${args.importer}); add one in src/compat and scripts/pi-compat-plugin.mjs`,
            },
          ],
        };
      });
    },
  };
}

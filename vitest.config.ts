import { defineConfig } from "vitest/config";

// One `pnpm test` runs every package. Each vendor family keeps its own setup
// file (they isolate HOME-relative caches differently); the Pi and OMP host
// packages bring their own vitest configs.
export default defineConfig({
  test: {
    // Streams record usage under ~/.ns-bridge/usage by default. Tests must not touch it.
    env: { NS_BRIDGE_USAGE: "0" },
    projects: [
      {
        test: {
          name: "bridge",
          include: ["packages/bridge-core/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "core-utils",
          include: ["packages/core-utils/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "kiro",
          include: ["packages/{kiro-core,omp-provider-kiro,dsh-llm-kiro}/test/**/*.test.ts"],
          setupFiles: ["./packages/kiro-core/test/setup.ts"],
          // The first cl100k_base rank load builds the BPE table and can
          // exceed the default 5s timeout while other files load it too.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "devin",
          include: ["packages/{devin-core,dsh-llm-devin}/test/**/*.test.ts"],
          setupFiles: ["./packages/devin-core/test/setup.ts"],
        },
      },
      {
        test: {
          name: "grok",
          include: ["packages/grok-core/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "grok-dsh",
          include: ["packages/dsh-llm-grok/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "cli",
          include: ["packages/cli/test/**/*.test.ts"],
        },
      },
      "packages/pi-provider",
      "packages/omp-provider",
    ],
  },
});

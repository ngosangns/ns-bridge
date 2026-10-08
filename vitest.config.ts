import { defineConfig } from "vitest/config";

// One `pnpm test` runs every package. Each vendor family keeps its own setup
// file (they isolate HOME-relative caches differently); the Pi and OMP host
// packages bring their own vitest configs.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "bridge",
          include: ["packages/{bridge-core,bridge-bin}/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "kiro",
          include: ["packages/{kiro-core,omp-provider-kiro,dsh-llm-kiro}/test/**/*.test.ts"],
          setupFiles: ["./packages/kiro-core/test/setup.ts"],
        },
      },
      {
        test: {
          name: "devin",
          include: ["packages/{devin-core,dsh-llm-devin}/test/**/*.test.ts"],
          setupFiles: ["./packages/devin-core/test/setup.ts"],
        },
      },
      "packages/pi-provider",
      "packages/omp-provider",
    ],
  },
});

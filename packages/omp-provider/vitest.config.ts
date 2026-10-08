import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // dist/index.js keeps @oh-my-pi/* external (OMP serves them at runtime).
      "@oh-my-pi/pi-ai": fileURLToPath(new URL("./tests/fixtures/omp-pi-ai-stub.ts", import.meta.url)),
    },
  },
  test: {
    name: "omp",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Exercise the in-process TypeScript cores, not an installed Go sidecar.
    env: { NS_BRIDGE_ENGINE: "ts" },
  },
});

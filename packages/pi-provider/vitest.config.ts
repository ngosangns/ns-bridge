import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "pi",
    include: ["tests/**/*.test.ts"],
    exclude: process.env.NS_PI_LIVE === "1" ? [] : ["tests/live/**"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/integration/**/*.test.ts"],
    setupFiles: ["src/__tests__/helpers/load-env.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share module state (DB singleton) — run sequentially
    pool: "forks",
    singleFork: true,
  },
});

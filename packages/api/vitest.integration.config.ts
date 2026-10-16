import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/integration/**/*.test.ts"],
    setupFiles: ["src/__tests__/helpers/load-env.ts"],
    globalSetup: ["src/__tests__/helpers/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share one database and module state (DB singleton,
    // the import-job engine) — run files sequentially. `singleFork` was
    // dropped in Vitest 4 and silently ignored; `fileParallelism` is the
    // supported switch.
    pool: "forks",
    fileParallelism: false,
  },
});

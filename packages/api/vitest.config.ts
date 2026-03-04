import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // Integration tests have their own config and require a live MySQL instance
    exclude: ["src/__tests__/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Scope unit test coverage to files with actual unit tests.
      // Router files require a live database and are covered by integration/e2e tests.
      include: [
        "src/draw/algorithms.ts",
        "src/draw/optimizer.ts",
        "src/results.ts",
      ],
      exclude: ["src/**/__tests__/**"],
      thresholds: {
        branches: 70,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});

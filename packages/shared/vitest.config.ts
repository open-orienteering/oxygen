import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Source only: `tsc -b` emits the test files into dist/ as well, and
    // running those duplicates every test against stale output.
    include: ["src/**/*.test.ts"],
  },
});

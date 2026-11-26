import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Shared code runs in browsers too; pin a zone that is not UTC so a
    // local-time versus UTC mix-up fails everywhere (BLD-14).
    env: { TZ: "Europe/Stockholm" },
    // Source only: `tsc -b` emits the test files into dist/ as well, and
    // running those duplicates every test against stale output.
    include: ["src/**/*.test.ts"],
  },
});

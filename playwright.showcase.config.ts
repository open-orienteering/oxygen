import { defineConfig, devices } from "@playwright/test";

/**
 * Showcase screenshots for the README and the feature tour
 * (docs/screenshots/README.md). Not part of `pnpm test:e2e`: it starts no
 * servers and attaches to a running Oxygen at `SHOWCASE_URL`, so the same
 * shots can be taken of the public Demo Competition (cloud or CI) or of a
 * private event on a laptop (`SHOWCASE_EVENT`, `SHOWCASE_PRIVATE=1`), where
 * the map never leaves the machine and only the PNGs do.
 *
 *   pnpm docs:showcase                       public shots → docs/screenshots/
 *   SHOWCASE_PRIVATE=1 SHOWCASE_EVENT=<nameId> pnpm docs:showcase
 *                                            read-only shots → .local/showcase-shots/
 */
const BASE_URL = process.env.SHOWCASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e/showcase",
  testMatch: "**/*.shot.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: "test-results/showcase",
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    locale: "en-GB",
    timezoneId: "Europe/Stockholm",
    colorScheme: "light",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", testIgnore: "**/*.phone.shot.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    { name: "phone", testMatch: "**/*.phone.shot.ts", use: { ...devices["Pixel 7"] } },
  ],
});

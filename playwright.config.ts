import { defineConfig, devices } from "@playwright/test";

/**
 * The stack is parameterized so the sharded runner
 * (`scripts/e2e-sharded.mjs`) can launch N fully isolated stacks in
 * parallel — each with its own Postgres database, API server, and Vite
 * dev server. Without these env vars set, a plain `playwright test` run
 * behaves exactly as before (single stack on 3002/5173 against
 * `oxygen_e2e`).
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 3002);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const DB_NAME = process.env.E2E_DB_NAME ?? "oxygen_e2e";
// Shard label (e.g. "1") — used to keep per-shard artifact dirs apart.
const SHARD = process.env.E2E_SHARD;

const DATABASE_URL = `postgresql://oxygen:oxygen@localhost:5433/${DB_NAME}?schema=oxygen`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  outputDir: SHARD ? `test-results/shard-${SHARD}` : "test-results",
  reporter: [
    ["html", { open: "never", outputFolder: SHARD ? `playwright-report/shard-${SHARD}` : "playwright-report" }],
    ["list"],
  ],

  use: {
    // 127.0.0.1, NOT localhost: the dev servers listen on IPv4 only, and
    // Playwright's request stack resolves localhost to ::1 first with a
    // ~10s fallback — every page.request call would stall (observed after
    // the 1.62 bump as 30s beforeEach timeouts).
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Run the dev servers before starting tests.
   * Set reuseExistingServer: true to use already-running servers during dev.
   * In CI, servers are started fresh by these commands. */
  webServer: [
    {
      command: "pnpm exec tsx packages/api/src/index.ts",
      port: API_PORT,
      reuseExistingServer: false,
      env: {
        // Dedicated E2E database in the test PG container (:5433). Kept
        // separate from the integration test DB so the two suites can't
        // clobber each other.
        DATABASE_URL,
        PORT: String(API_PORT),
        // Lets lease.spec.ts drive the node-to-node lease surface
        // (lease.acquire) the way a peer node would.
        SYNC_SHARED_SECRET: "e2e-sync-secret",
      },
    },
    {
      command: "pnpm --filter @oxygen/web dev",
      port: WEB_PORT,
      // Shards use unique ports, so a fresh server is always started for
      // them; the default port keeps reusing an already-running dev server.
      reuseExistingServer: true,
      env: {
        WEB_PORT: String(WEB_PORT),
        API_PROXY_PORT: String(API_PORT),
      },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";
import { E2E_API_PORT, E2E_EVENTOR_PORT, E2E_WEB_PORT } from "./e2e/helpers/ports";
import type { MapPipeline } from "./e2e/helpers/map-pipeline";

/**
 * Specs run once per map pipeline while both exist
 * (docs/map-pipeline-switch.md §5, 09 §3 / §10): projects `map-legacy`
 * and `map-vector` set every event's `map_pipeline` before each test.
 * They import `test` from `e2e/helpers/map-pipeline.ts`. Every other
 * spec runs once, in `chromium`, on whatever the spec sets itself.
 */
export const MAP_PIPELINE_SPECS = [
  "**/webserial.spec.ts",
  "**/mobile-layout.spec.ts",
  "**/map-viewer-gestures.spec.ts",
  "**/map-control-circles.spec.ts",
  "**/map-multicourse.spec.ts",
  "**/course-maps.spec.ts",
];

/**
 * The stack is parameterized so the sharded runner
 * (`scripts/e2e-sharded.mjs`) can launch N fully isolated stacks in
 * parallel — each with its own Postgres database, API server, and Vite
 * dev server. Without these env vars set, a plain `playwright test` run
 * is a single stack on 4100/4200/4300 against `oxygen_e2e` — ports of its
 * own (`e2e/helpers/ports.ts`), never the dev servers' 3002/5173, and
 * every server is started by the run itself (see `webServer` below), so
 * it always tests the code of the checkout it is run from.
 */
const API_PORT = E2E_API_PORT;
const WEB_PORT = E2E_WEB_PORT;
const EVENTOR_PORT = E2E_EVENTOR_PORT;
const DB_NAME = process.env.E2E_DB_NAME ?? "oxygen_e2e";
// Shard label (e.g. "1") — used to keep per-shard artifact dirs apart.
const SHARD = process.env.E2E_SHARD;

const DATABASE_URL = `postgresql://oxygen:oxygen@localhost:5433/${DB_NAME}?schema=oxygen`;

export default defineConfig<{ mapPipeline: MapPipeline }>({
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
    extraHTTPHeaders: {
      "x-forwarded-email": "e2e-admin@oxygen.test",
    },
  },

  projects: [
    {
      name: "chromium",
      testIgnore: MAP_PIPELINE_SPECS,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "map-legacy",
      testMatch: MAP_PIPELINE_SPECS,
      use: { ...devices["Desktop Chrome"], mapPipeline: "legacy" },
    },
    {
      name: "map-vector",
      testMatch: MAP_PIPELINE_SPECS,
      use: { ...devices["Desktop Chrome"], mapPipeline: "vector" },
    },
  ],

  /* Start the servers before the tests. `reuseExistingServer` is false for
   * all three on purpose: a run must never attach to a server it did not
   * start. Attaching silently tests whatever code that server runs — the
   * main checkout's `pnpm dev` from a worktree, or an orphan left behind by
   * a crashed run of another worktree — so a port already in use is an
   * error ("... is already used"), not a shortcut. */
  webServer: [
    {
      command: "pnpm exec tsx e2e/helpers/ensure-e2e-db.ts && pnpm exec tsx packages/api/src/index.ts",
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
        // Keep Eventor calls inside the stack. Without this the suite
        // depends on eventor.orientering.se being up and on it accepting
        // the placeholder key, neither of which holds.
        EVENTOR_API_BASE_URL: `http://127.0.0.1:${EVENTOR_PORT}/`,
        AUTH_MODE: "proxy",
        OXYGEN_ADMIN_EMAILS: "e2e-admin@oxygen.test",
        OXYGEN_BUILD_ID: "e81729be4f7fd564c47bb2098137403ef6dcb922",
        OXYGEN_DEPLOY_REF: "e2e",
        // Read the map pipeline flags on every request: the dual-run
        // projects flip `map.pipeline.default` between tests.
        MAP_PIPELINE_FLAGS_TTL_MS: "0",
        RSVG_CONVERT_COMMAND: `${process.cwd()}/e2e/helpers/fake-rsvg-convert.mjs`,
      },
    },
    {
      command: "node e2e/eventor-stub.mjs",
      port: EVENTOR_PORT,
      reuseExistingServer: false,
      env: {
        EVENTOR_STUB_PORT: String(EVENTOR_PORT),
      },
    },
    {
      command: "pnpm --filter @oxygen/web dev",
      port: WEB_PORT,
      reuseExistingServer: false,
      env: {
        WEB_PORT: String(WEB_PORT),
        API_PROXY_PORT: String(API_PORT),
      },
    },
  ],
});

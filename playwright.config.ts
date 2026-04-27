import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: "http://localhost:5173",
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
      port: 3002,
      reuseExistingServer: true,
      env: {
        DATABASE_URL: "mysql://meos@localhost:3306/itest",
        MEOS_MAIN_DB_URL: "mysql://meos@localhost:3306/MeOSMain",
        PORT: "3002",
      },
    },
    {
      command: "pnpm --filter @oxygen/web dev",
      port: 5173,
      reuseExistingServer: true,
    },
  ],
});

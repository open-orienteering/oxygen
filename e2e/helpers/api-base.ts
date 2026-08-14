/**
 * Base URL for direct API calls (bypassing the Vite proxy).
 *
 * The port is parameterized so the sharded E2E runner
 * (`scripts/e2e-sharded.mjs`) can point each shard at its own API
 * instance. Plain `playwright test` runs keep the historical default.
 *
 * 127.0.0.1, NOT localhost: the dev servers listen on IPv4 only (see the
 * comment in playwright.config.ts).
 */
export const API_BASE = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 3002}`;

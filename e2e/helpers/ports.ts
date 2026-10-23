/**
 * Default ports of an E2E stack that was not given explicit `E2E_*_PORT`
 * variables: a plain `playwright test`, `pnpm test:e2e:serial`, or the
 * selective path of `scripts/e2e-sharded.mjs`.
 *
 * These are the sharded runner's 4100 / 4200 / 4300 bases (shard `n` uses
 * base + n, see `scripts/e2e-sharded.mjs`), so the default stack sits next
 * to the shards and clear of everything else on the machine: the dev
 * servers (3002 / 5173) and the Docker stack (3001 / 8080). A run from a
 * worktree therefore never talks to the main checkout's `pnpm dev`.
 *
 * Keep the bases in step with `API_PORT_BASE` / `WEB_PORT_BASE` /
 * `EVENTOR_PORT_BASE` in `scripts/e2e-sharded.mjs`.
 */
export const E2E_DEFAULT_API_PORT = 4100;
export const E2E_DEFAULT_WEB_PORT = 4200;
export const E2E_DEFAULT_EVENTOR_PORT = 4300;

export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? E2E_DEFAULT_API_PORT);
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? E2E_DEFAULT_WEB_PORT);
export const E2E_EVENTOR_PORT = Number(
  process.env.E2E_EVENTOR_PORT ?? E2E_DEFAULT_EVENTOR_PORT,
);

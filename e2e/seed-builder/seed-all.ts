/**
 * Run all three seed builders in one process:
 *
 *   DATABASE_URL=... pnpm exec tsx e2e/seed-builder/seed-all.ts
 *
 * `e2e/global-setup.ts` and `e2e/helpers/reseed.ts` spawn this script
 * instead of one child process per builder — tsx/pnpm startup used to
 * cost ~4-6s per reseed. It has to stay a separate process (rather than
 * an in-process import) because the generated Prisma client lives in the
 * ESM `packages/api` package, which Playwright's CJS test transform
 * cannot load.
 */
import { buildItest } from "./build-itest.js";
import { buildMultirace } from "./build-multirace.js";
import { buildTestCompetition } from "./build-test-competition.js";

async function main() {
  await buildItest();
  await buildMultirace();
  await buildTestCompetition();
}

main().catch((err) => {
  console.error("[seed:all] failed:", err);
  process.exit(1);
});

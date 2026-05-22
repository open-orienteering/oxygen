/**
 * Per-spec database reseed helper.
 *
 * Playwright's `globalSetup` only runs once per test session, but many
 * specs in this suite mutate fixtures (creating/deleting controls,
 * runners, clubs, etc.). Without a clean baseline between specs, later
 * specs see drifted counts and fail in confusing ways.
 *
 * Call `reseed()` from a `test.beforeAll(...)` in any spec that depends
 * on the canonical seed counts. The implementation talks to Postgres
 * directly so it doesn't require a running API — it just deletes the
 * three seed events (cascading) and re-runs the builders.
 */
import { execSync } from "child_process";
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://oxygen:oxygen@localhost:5433/oxygen_e2e?schema=oxygen";

const SEED_NAME_IDS = [
  "itest",
  "itest_multirace",
  "meos_20251222_001121_2BC",
] as const;

const BUILDERS = [
  "e2e/seed-builder/build-itest.ts",
  "e2e/seed-builder/build-multirace.ts",
  "e2e/seed-builder/build-test-competition.ts",
];

/**
 * Wipe & recreate the three seed events. Idempotent and ~1-2s.
 * Call from `test.beforeAll(reseed)` in mutating specs.
 */
export async function reseed(): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    const args = [...SEED_NAME_IDS];
    const placeholders = SEED_NAME_IDS.map((_, i) => `$${i + 1}`).join(",");
    await client.query(
      `DELETE FROM events WHERE name_id IN (${placeholders}) OR name_id LIKE 'E2E_%' OR name_id LIKE 'Delete_%'`,
      args,
    );
  } finally {
    await client.end();
  }

  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  for (const builder of BUILDERS) {
    execSync(`pnpm exec tsx ${builder}`, { stdio: "ignore", env });
  }
}

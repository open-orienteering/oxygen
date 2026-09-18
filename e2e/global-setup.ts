/**
 * Playwright global setup for the new Postgres backend.
 *
 *   1. Ensure the dedicated E2E database (`oxygen_e2e` on :5433) exists.
 *   2. Apply Prisma migrations.
 *   3. Clean up leftover seed events + any `E2E_*` events from prior runs.
 *   4. Programmatically seed the three reference events:
 *        - `itest`                       — "My example tävling"
 *        - `itest_multirace`             — "Multi-Race Series"
 *        - `meos_20251222_001121_2BC`    — "Test competition"
 *
 * All seeding is done with the Prisma client. The previous mysqldump-based
 * `seed*.sql` files are gone — see `e2e/seed-builder/` for the source of
 * truth (run automatically as part of this setup).
 *
 * The API webServer process also runs ensure-e2e-db before listen, because
 * Playwright starts webServer before this globalSetup.
 */
import { Client } from "pg";
import { execSync } from "child_process";
import {
  applyE2eMigrations,
  e2eDatabaseUrl,
  e2eDbName,
  ensureE2eDatabase,
} from "./helpers/ensure-e2e-db";

const E2E_DB_NAME = e2eDbName();

export const E2E_DATABASE_URL = e2eDatabaseUrl(E2E_DB_NAME);

/** Seed event slugs known to this suite. Kept here so cleanup matches them. */
export const SEED_NAME_IDS = [
  "itest",
  "itest_multirace",
  "meos_20251222_001121_2BC",
] as const;

async function cleanStaleEvents(): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    const seedPlaceholders = SEED_NAME_IDS.map((_, i) => `$${i + 1}`).join(",");
    const args = [...SEED_NAME_IDS];
    await client.query(
      `DELETE FROM events WHERE name_id IN (${seedPlaceholders}) OR name_id LIKE 'E2E_%' OR name_id LIKE 'Delete_%' OR name_id LIKE 'oxygen_test_%'`,
      args,
    );
    // Reset relevant global-scope rows so a re-run gives the same Eventor /
    // online-input state (these tests sometimes write to global settings).
    await client.query(
      `DELETE FROM settings WHERE key IN ('eventor_api_key', 'eventor_api_key_test')`,
    );
  } finally {
    await client.end();
  }
}

async function runSeeds(): Promise<void> {
  console.log(`  [setup] Seeding events via builders...`);
  // One tsx child process runs all three builders (see seed-all.ts for
  // why this can't be an in-process import).
  execSync("pnpm exec tsx e2e/seed-builder/seed-all.ts", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}

export default async function globalSetup(): Promise<void> {
  console.log("  [setup] Provisioning E2E Postgres database...");
  await ensureE2eDatabase(E2E_DB_NAME);
  applyE2eMigrations(E2E_DB_NAME);
  await cleanStaleEvents();
  await runSeeds();
  console.log("  [setup] E2E database ready.");
}

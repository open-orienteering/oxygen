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
 */
import { Client } from "pg";
import { execSync } from "child_process";

const TEST_HOST = "localhost";
const TEST_PORT = 5433;
const TEST_USER = "oxygen";
const TEST_PASSWORD = "oxygen";
const E2E_DB_NAME = "oxygen_e2e";

export const E2E_DATABASE_URL =
  `postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_HOST}:${TEST_PORT}/${E2E_DB_NAME}?schema=oxygen`;

const ADMIN_URL =
  `postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_HOST}:${TEST_PORT}/postgres`;

/** Seed event slugs known to this suite. Kept here so cleanup matches them. */
export const SEED_NAME_IDS = [
  "itest",
  "itest_multirace",
  "meos_20251222_001121_2BC",
] as const;

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [E2E_DB_NAME],
    );
    if (exists.rows.length === 0) {
      console.log(`  [setup] Creating database "${E2E_DB_NAME}"...`);
      await admin.query(`CREATE DATABASE "${E2E_DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

function applyMigrations(): void {
  console.log(`  [setup] Applying Prisma migrations to ${E2E_DB_NAME}...`);
  try {
    execSync("pnpm --filter @oxygen/api exec prisma migrate deploy", {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    });
  } catch (err) {
    throw new Error(
      `[global-setup] prisma migrate deploy failed against ${E2E_DB_NAME}: ${String(err)}`,
    );
  }
}

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
  // Each builder is an isolated script that connects via DATABASE_URL.
  // Run them in-process via tsx for fast startup.
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  const builders = [
    "e2e/seed-builder/build-itest.ts",
    "e2e/seed-builder/build-multirace.ts",
    "e2e/seed-builder/build-test-competition.ts",
  ];
  for (const builder of builders) {
    execSync(`pnpm exec tsx ${builder}`, {
      stdio: "inherit",
      env,
    });
  }
}

export default async function globalSetup(): Promise<void> {
  console.log("  [setup] Provisioning E2E Postgres database...");
  await ensureDatabase();
  applyMigrations();
  await cleanStaleEvents();
  await runSeeds();
  console.log("  [setup] E2E database ready.");
}

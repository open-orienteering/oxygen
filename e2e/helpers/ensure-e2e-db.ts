/**
 * Create the per-stack E2E database and apply Prisma migrations.
 *
 * Playwright starts `webServer` (the API) *before* `globalSetup`. On a
 * developer machine the oxygen_e2e_* databases usually already exist from
 * a previous run; on a clean CI Postgres they do not, and the API dies
 * with DatabaseDoesNotExist. This helper is therefore invoked from the
 * API webServer command as well as from global-setup (idempotent).
 */
import { Client } from "pg";
import { execSync } from "child_process";

const TEST_HOST = "localhost";
const TEST_PORT = 5433;
const TEST_USER = "oxygen";
const TEST_PASSWORD = "oxygen";

export function e2eDbName(): string {
  return process.env.E2E_DB_NAME ?? "oxygen_e2e";
}

export function e2eDatabaseUrl(dbName = e2eDbName()): string {
  return `postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_HOST}:${TEST_PORT}/${dbName}?schema=oxygen`;
}

function adminUrl(): string {
  return `postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_HOST}:${TEST_PORT}/postgres`;
}

export async function ensureE2eDatabase(dbName = e2eDbName()): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const exists = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (exists.rows.length === 0) {
      console.log(`[e2e-db] Creating database "${dbName}"...`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

export function applyE2eMigrations(dbName = e2eDbName()): void {
  const url = e2eDatabaseUrl(dbName);
  console.log(`[e2e-db] Applying Prisma migrations to ${dbName}...`);
  execSync("pnpm --filter @oxygen/api exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}

const invokedDirectly =
  process.argv[1]?.includes("ensure-e2e-db") === true;

if (invokedDirectly) {
  const dbName = e2eDbName();
  ensureE2eDatabase(dbName)
    .then(() => applyE2eMigrations(dbName))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

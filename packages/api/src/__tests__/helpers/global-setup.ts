/**
 * Global setup for integration tests.
 *
 * Runs once before any test file starts. Responsibilities:
 *   1. Verify the test Postgres container on :5433 is reachable.
 *   2. Apply pending Prisma migrations into the test DB.
 *   3. Wipe any leftover `oxygen_test_*` events from interrupted runs
 *      (FK cascades clean up all child rows).
 *
 * After this runs, every suite gets a clean `oxygen.events` table modulo
 * any rows the suite itself created.
 */

import { Client } from "pg";
import { execSync } from "child_process";

// Re-use the same env resolution as the test helper. We can't import
// load-env directly because globalSetup runs in a different module
// graph; mirror its logic.
import "dotenv/config";

const TEST_DB_DEFAULT =
  "postgresql://oxygen:oxygen@localhost:5433/oxygen_test?schema=oxygen";

function resolveTestUrl(): string {
  const url = process.env.INTEGRATION_DATABASE_URL ?? TEST_DB_DEFAULT;
  const parsed = new URL(url);
  const port =
    parsed.port || (parsed.protocol === "postgres:" ? "5432" : "5432");
  const hostIsLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (hostIsLocal && port === "5432") {
    throw new Error(
      "[integration tests] Refusing to run: resolved test URL points at port 5432 (the dev DB). " +
        "Set INTEGRATION_DATABASE_URL or bring up docker-compose.test.yml.",
    );
  }
  return url;
}

export async function setup() {
  const url = resolveTestUrl();
  process.env.DATABASE_URL = url;

  // Apply migrations. We use `prisma migrate deploy` against the
  // resolved URL — idempotent and fast if everything's already there.
  try {
    execSync("pnpm --filter @oxygen/api exec prisma migrate deploy", {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (err) {
    throw new Error(
      `[global-setup] prisma migrate deploy failed against ${url.replace(/:[^:@]+@/, ":***@")}: ${String(err)}`,
    );
  }

  // Cleanup stale test events from previous interrupted runs.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Set search_path so we can address tables unqualified.
    await client.query("SET search_path TO oxygen, public");
    const res = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE name_id LIKE 'oxygen_test_%' OR name_id LIKE 'E2E_%'",
    );
    const stale = parseInt(res.rows[0]?.count ?? "0", 10);
    if (stale > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[global-setup] Cleaning up ${stale} stale test event(s) from previous run...`,
      );
      await client.query(
        "DELETE FROM events WHERE name_id LIKE 'oxygen_test_%' OR name_id LIKE 'E2E_%'",
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Load env for integration tests and force the integration suite to talk
 * to the dedicated test Postgres container — never the developer's dev
 * database.
 *
 * The dedicated test container runs on port 5433 (see
 * docker-compose.test.yml). We refuse to start if DATABASE_URL appears
 * to point at the dev DB (port 5432) — that was the historical
 * foot-gun where integration tests would wipe live working data.
 *
 * Override with INTEGRATION_DATABASE_URL if you need to point at a
 * different test instance (CI, remote PG, etc).
 */

import "dotenv/config";
// Mount the BigInt→JSON polyfill before any router code runs so
// integration tests serialize tRPC responses the same way the live
// server does. Without it, anything returning a Prisma row with a
// BigInt PK 500s the moment a caller tries to JSON.stringify it.
import "../../bigint-json.js";

const TEST_DB_DEFAULT =
  "postgresql://oxygen:oxygen@localhost:5433/oxygen_test?schema=oxygen";

const url = process.env.INTEGRATION_DATABASE_URL ?? TEST_DB_DEFAULT;

// Hard-stop if the resolved URL looks like the dev database. Port 5432
// is the dev DB convention; anything else we trust the operator.
const parsed = new URL(url);
const port = parsed.port || (parsed.protocol === "postgres:" ? "5432" : "5432");
const hostIsLocal =
  parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
if (hostIsLocal && port === "5432") {
  throw new Error(
    `[integration tests] Refusing to run: INTEGRATION_DATABASE_URL / fallback resolves to port 5432, which is the developer's dev DB. ` +
      `Bring up the test container (\`docker compose -f docker-compose.test.yml up -d\`) and rerun. ` +
      `Resolved URL: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

process.env.DATABASE_URL = url;

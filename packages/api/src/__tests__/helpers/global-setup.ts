/**
 * Global setup for integration tests.
 *
 * Runs once before any test file starts. Drops all stale oxygen_test_*
 * databases left over from interrupted or crashed previous test runs,
 * so they don't accumulate indefinitely.
 */

import mysql from "mysql2/promise";
import "dotenv/config";

export async function setup() {
  const dbUrl = process.env.DATABASE_URL;
  const mainUrl = process.env.MEOS_MAIN_DB_URL;
  if (!dbUrl || !mainUrl) return;

  // Strip the database name from DATABASE_URL to get a server-level connection
  const serverUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, "/$1");

  const [conn, mainConn] = await Promise.all([
    mysql.createConnection(serverUrl),
    mysql.createConnection(mainUrl),
  ]);

  try {
    // Find all stale oxygen_test_* databases
    const [rows] = await conn.execute(
      "SHOW DATABASES LIKE 'oxygen_test_%'",
    );
    const databases = (rows as Record<string, string>[]).map(
      (r) => Object.values(r)[0],
    );

    if (databases.length === 0) return;

    console.log(`[global-setup] Cleaning up ${databases.length} stale test database(s)...`);

    await Promise.all(
      databases.map(async (db) => {
        await conn.execute(`DROP DATABASE IF EXISTS \`${db}\``);
        await mainConn.execute("DELETE FROM oEvent WHERE NameId = ?", [db]);
      }),
    );

    console.log(`[global-setup] Dropped: ${databases.join(", ")}`);
  } finally {
    await Promise.all([conn.end(), mainConn.end()]);
  }
}

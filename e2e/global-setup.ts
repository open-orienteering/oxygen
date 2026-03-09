import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Database seeds for E2E tests.
 * Each entry specifies a database name, its seed SQL file, and
 * the MeOSMain oEvent entry to create.
 */
const SEEDS: Array<{
  dbName: string;
  seedFile: string;
  eventName: string;
  eventDate: string;
}> = [
  {
    dbName: "itest",
    seedFile: "seed.sql",
    eventName: "My example tävling",
    eventDate: "2026-04-15",
  },
  {
    dbName: "itest_vinterserien",
    seedFile: "seed-vinterserien.sql",
    eventName: "Vinterserien",
    eventDate: "2026-03-15",
  },
  {
    dbName: "meos_20251222_001121_2BC",
    seedFile: "seed-test-competition.sql",
    eventName: "Test competition",
    eventDate: "2026-04-01",
  },
];

/**
 * Playwright global setup:
 *   1. Drop and recreate all test databases from clean seeds
 *   2. Ensure MeOSMain has the required competition entries
 *   3. Clean up leftover E2E test databases from previous runs
 *
 * This guarantees every test run starts from the exact same state
 * with zero dependency on pre-existing data.
 */
export default async function globalSetup() {
  const conn = await mysql.createConnection({
    host: "localhost",
    user: "meos",
    database: "MeOSMain",
    multipleStatements: true,
  });

  try {
    // ── 1. Recreate test databases from seeds ─────────────────

    for (const seed of SEEDS) {
      console.log(`  [setup] Recreating ${seed.dbName} from ${seed.seedFile}...`);

      await conn.execute(`DROP DATABASE IF EXISTS \`${seed.dbName}\``);
      await conn.execute(
        `CREATE DATABASE \`${seed.dbName}\` CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci`,
      );

      const seedPath = resolve(__dirname, seed.seedFile);
      const seedSql = readFileSync(seedPath, "utf-8");

      const seedConn = await mysql.createConnection({
        host: "localhost",
        user: "meos",
        database: seed.dbName,
        multipleStatements: true,
      });
      try {
        await seedConn.query(seedSql);
      } finally {
        await seedConn.end();
      }

      // Ensure MeOSMain has the competition entry
      await conn.execute(`DELETE FROM oEvent WHERE NameId = ?`, [seed.dbName]);
      await conn.execute(
        `INSERT INTO oEvent (Name, Date, NameId, Removed) VALUES (?, ?, ?, 0)`,
        [seed.eventName, seed.eventDate, seed.dbName],
      );
    }

    console.log("  [setup] All test databases seeded successfully");

    // ── 2. Clean up leftover E2E test databases ───────────────

    const [rows] = await conn.execute(
      "SELECT Id, NameId FROM oEvent WHERE (NameId LIKE 'E2E\\_%' OR NameId LIKE 'Delete\\_%' OR NameId LIKE 'oxygen\\_test\\_%') AND Removed = 0",
    );

    if (Array.isArray(rows)) {
      for (const row of rows as Array<{ Id: number; NameId: string }>) {
        try {
          await conn.execute(`DROP DATABASE IF EXISTS \`${row.NameId}\``);
          await conn.execute("UPDATE oEvent SET Removed = 1 WHERE Id = ?", [row.Id]);
          console.log(`  [setup] Cleaned up leftover test DB: ${row.NameId}`);
        } catch {
          // Ignore errors for individual DBs
        }
      }
    }
  } finally {
    await conn.end();
  }
}

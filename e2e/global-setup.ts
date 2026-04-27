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
    dbName: "itest_multirace",
    seedFile: "seed-multirace.sql",
    eventName: "Multi-Race Series",
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
 * Eventor API key settings that the E2E suite mutates (clearKey,
 * validateKey). They live in the shared MeOSMain.oxygen_settings table
 * alongside the developer's real keys, so we snapshot them here and
 * restore them in global-teardown. See e2e/global-teardown.ts.
 */
export const EVENTOR_KEYS_TO_PRESERVE = [
  "eventor_api_key",
  "eventor_api_key_test",
] as const;
const E2E_BACKUP_PREFIX = "e2e_backup_";
/** Sentinel meaning "the original row did not exist; restore = delete". */
const E2E_BACKUP_NULL = "__E2E_NULL__";

/**
 * Playwright global setup:
 *   1. Snapshot Eventor API key settings (so individual tests can
 *      legitimately clear/set them without trashing the developer's
 *      real keys).
 *   2. Drop and recreate all test databases from clean seeds
 *   3. Ensure MeOSMain has the required competition entries
 *   4. Clean up leftover E2E test databases from previous runs
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
    // ── 0. Snapshot Eventor key settings ──────────────────────
    // The eventor.clearKey / eventor.validateKey mutations write to
    // MeOSMain.oxygen_settings, which is shared with everything else
    // running against this MySQL instance. Without a backup, every
    // E2E run wipes the developer's real Eventor API key.
    //
    // Idempotency: if a backup row already exists from a previously
    // interrupted run, leave it alone — overwriting it would lose
    // the original value and cement the test-injected key as the
    // "real" one on the next teardown.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS oxygen_settings (
        SettingKey   VARCHAR(128) NOT NULL PRIMARY KEY,
        SettingValue TEXT NULL
      )
    `);
    for (const key of EVENTOR_KEYS_TO_PRESERVE) {
      const backupKey = `${E2E_BACKUP_PREFIX}${key}`;
      const [backupRows] = await conn.execute(
        "SELECT 1 FROM oxygen_settings WHERE SettingKey = ?",
        [backupKey],
      );
      if (Array.isArray(backupRows) && backupRows.length > 0) {
        console.log(
          `  [setup] Eventor key backup for "${key}" already exists from a prior run — leaving it intact.`,
        );
        continue;
      }
      const [rows] = await conn.execute(
        "SELECT SettingValue FROM oxygen_settings WHERE SettingKey = ?",
        [key],
      );
      const arr = rows as Array<{ SettingValue: string | null }>;
      const original = arr.length > 0 ? arr[0].SettingValue : null;
      await conn.execute(
        `INSERT INTO oxygen_settings (SettingKey, SettingValue) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
        [backupKey, original ?? E2E_BACKUP_NULL],
      );
    }
    console.log("  [setup] Eventor key settings snapshotted");

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

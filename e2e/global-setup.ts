import mysql from "mysql2/promise";
import { readFileSync, writeFileSync, existsSync } from "fs";
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
 * alongside the developer's real keys, so we snapshot them to a local
 * file (gitignored) and restore them in global-teardown.
 *
 * Earlier revisions stored the snapshot back into oxygen_settings as
 * `e2e_backup_*` rows. That broke whenever a run was interrupted before
 * teardown: the live key was lost and the backup row could end up
 * containing test-pollution, which was then "restored" on the next run
 * and silently overwrote the developer's freshly re-entered key.
 *
 * The file-based snapshot below survives interrupts and (importantly)
 * is updated on every setup that observes a real value, so manually
 * re-entering the key after an interrupted run is also picked up
 * correctly on the next teardown.
 */
export const EVENTOR_KEYS_TO_PRESERVE = [
  "eventor_api_key",
  "eventor_api_key_test",
] as const;

const SNAPSHOT_PATH = resolve(__dirname, ".eventor-snapshot.json");

/** Placeholder value the e2e suite writes via validateKey. */
const TEST_PLACEHOLDER = "df34af90a0c64ca4abfe9492be057e9c";

/**
 * Strings any test in this repo might leak into oxygen_settings as a
 * "fake" key. Real Eventor API keys are 32 lowercase hex chars, so any
 * recognisable English/dash word value is also a clear giveaway.
 */
const KNOWN_FAKE_KEY_TOKENS = [
  TEST_PLACEHOLDER,
  "fake",
  "test",
  "dummy",
  "placeholder",
];

/**
 * "Test pollution" = a value the e2e suite (or any other test in this
 * repo) might have written:
 *   - empty / null / undefined
 *   - the literal placeholder string
 *   - anything containing an obvious "fake/test/dummy" token
 * Anything else is treated as a real value worth preserving.
 *
 * Conservative on purpose: a few false negatives (real keys that happen
 * to contain "test") would just refresh the snapshot from a value that
 * already matches; a single false positive (treating a real key as
 * pollution) would silently drop it. The token list is therefore kept
 * to strings that no real Eventor key would ever contain.
 */
function isTestPollution(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  const lower = trimmed.toLowerCase();
  for (const token of KNOWN_FAKE_KEY_TOKENS) {
    if (lower === token.toLowerCase()) return true;
    if (lower.includes(token)) return true;
  }
  return false;
}

interface Snapshot {
  /** Per-key real value (null = "the row was originally absent / empty"). */
  [key: string]: string | null;
}

function readSnapshot(): Snapshot {
  if (!existsSync(SNAPSHOT_PATH)) return {};
  try {
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Snapshot;
  } catch {
    // Unreadable / corrupt — fall through to empty snapshot. Teardown
    // logic treats "no snapshot entry" as "do nothing", which is the
    // safe default.
  }
  return {};
}

function writeSnapshot(snapshot: Snapshot): void {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
}

/**
 * Playwright global setup:
 *   0. Update file-based Eventor key snapshot from the live values, but
 *      only when the live value isn't test-pollution. This way:
 *        - First run after a fresh key entry → snapshot file is written.
 *        - Run after an interrupted run (live still polluted) → existing
 *          snapshot is kept untouched.
 *        - Run after the user manually re-entered the key post-interrupt
 *          → snapshot file is overwritten with the new real value.
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
    // ── 0. Snapshot Eventor key settings to file ──────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS oxygen_settings (
        SettingKey   VARCHAR(128) NOT NULL PRIMARY KEY,
        SettingValue TEXT NULL
      )
    `);

    const snapshot = readSnapshot();
    let snapshotChanged = false;
    for (const key of EVENTOR_KEYS_TO_PRESERVE) {
      const [rows] = await conn.execute(
        "SELECT SettingValue FROM oxygen_settings WHERE SettingKey = ?",
        [key],
      );
      const arr = rows as Array<{ SettingValue: string | null }>;
      const live = arr.length > 0 ? arr[0].SettingValue : null;

      if (isTestPollution(live)) {
        // Don't overwrite a previously-captured real value with test
        // pollution. If we have nothing yet, record null to mean "row
        // was originally absent / empty".
        if (!(key in snapshot)) {
          snapshot[key] = null;
          snapshotChanged = true;
          console.log(`  [setup] No prior snapshot for "${key}"; recording empty baseline.`);
        } else {
          console.log(`  [setup] Keeping existing snapshot for "${key}" (live is test-pollution).`);
        }
      } else {
        // Live value looks real. If it differs from the snapshot,
        // refresh the snapshot — the user may have just re-entered a
        // new key after an interrupted run.
        if (snapshot[key] !== live) {
          snapshot[key] = live;
          snapshotChanged = true;
          console.log(`  [setup] Updated snapshot for "${key}" from live value.`);
        }
      }
    }
    if (snapshotChanged) writeSnapshot(snapshot);
    console.log(`  [setup] Eventor key snapshot at ${SNAPSHOT_PATH}`);

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

    // ── 3. Clean up any legacy DB-resident backup rows ────────
    // Earlier versions of this script stashed the snapshot in
    // oxygen_settings as `e2e_backup_*` rows. Those are now stale and
    // should never be used to "restore" anything — drop them so we
    // don't accidentally read a value left over from a botched run.
    try {
      await conn.execute(
        "DELETE FROM oxygen_settings WHERE SettingKey LIKE 'e2e_backup_%'",
      );
    } catch {
      // ignore
    }
  } finally {
    await conn.end();
  }
}

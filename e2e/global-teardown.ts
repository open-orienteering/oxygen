import mysql from "mysql2/promise";
import { EVENTOR_KEYS_TO_PRESERVE } from "./global-setup";

const E2E_BACKUP_PREFIX = "e2e_backup_";
const E2E_BACKUP_NULL = "__E2E_NULL__";

/**
 * Playwright global teardown.
 *
 * Restores the Eventor API key settings snapshotted in global-setup so
 * that running the E2E suite does not silently delete or overwrite the
 * developer's real Eventor API key in MeOSMain.oxygen_settings.
 *
 * Robust to interrupted runs: if no backup row exists (because setup
 * never ran, or the backup was already restored), we do nothing rather
 * than guessing.
 */
export default async function globalTeardown() {
  const conn = await mysql.createConnection({
    host: "localhost",
    user: "meos",
    database: "MeOSMain",
    multipleStatements: true,
  });

  try {
    for (const key of EVENTOR_KEYS_TO_PRESERVE) {
      const backupKey = `${E2E_BACKUP_PREFIX}${key}`;
      const [rows] = await conn.execute(
        "SELECT SettingValue FROM oxygen_settings WHERE SettingKey = ?",
        [backupKey],
      );
      const arr = rows as Array<{ SettingValue: string | null }>;
      if (arr.length === 0) continue;

      const backupValue = arr[0].SettingValue;
      if (backupValue === null || backupValue === E2E_BACKUP_NULL) {
        await conn.execute(
          "DELETE FROM oxygen_settings WHERE SettingKey = ?",
          [key],
        );
      } else {
        await conn.execute(
          `INSERT INTO oxygen_settings (SettingKey, SettingValue) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
          [key, backupValue],
        );
      }
      await conn.execute(
        "DELETE FROM oxygen_settings WHERE SettingKey = ?",
        [backupKey],
      );
    }
    console.log("  [teardown] Eventor key settings restored");
  } finally {
    await conn.end();
  }
}

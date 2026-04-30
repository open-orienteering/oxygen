import mysql from "mysql2/promise";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { EVENTOR_KEYS_TO_PRESERVE } from "./global-setup";

const SNAPSHOT_PATH = resolve(__dirname, ".eventor-snapshot.json");

interface Snapshot {
  [key: string]: string | null;
}

function readSnapshot(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Snapshot;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Playwright global teardown.
 *
 * Restores the Eventor API key settings recorded in the file-based
 * snapshot from global-setup so that running the E2E suite does not
 * silently delete or overwrite the developer's real Eventor API key
 * in MeOSMain.oxygen_settings.
 *
 * Robust to interrupted runs: the snapshot is durable on disk, so even
 * if a run is killed before teardown, the next clean teardown can still
 * restore from the same file.
 */
export default async function globalTeardown() {
  const snapshot = readSnapshot();
  if (!snapshot) {
    console.log("  [teardown] No Eventor key snapshot file — nothing to restore.");
    return;
  }

  const conn = await mysql.createConnection({
    host: "localhost",
    user: "meos",
    database: "MeOSMain",
    multipleStatements: true,
  });

  try {
    for (const key of EVENTOR_KEYS_TO_PRESERVE) {
      // Missing snapshot entry → leave the live row alone. Defensive
      // default: do nothing rather than guess.
      if (!(key in snapshot)) continue;

      const value = snapshot[key];
      if (value === null || value === undefined || value === "") {
        // Snapshot says "originally absent / empty": delete the row.
        await conn.execute(
          "DELETE FROM oxygen_settings WHERE SettingKey = ?",
          [key],
        );
      } else {
        await conn.execute(
          `INSERT INTO oxygen_settings (SettingKey, SettingValue) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
          [key, value],
        );
      }
    }
    console.log("  [teardown] Eventor key settings restored from snapshot");
  } finally {
    await conn.end();
  }
}

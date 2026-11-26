import { BackupReadIncompleteError } from "./webserial";
import type { BackupResult } from "./webserial";
import type { SkippedBackupSlot } from "./si-protocol";

/**
 * The read -> import -> clear decision for a station backup, kept apart from
 * the React page so it can be tested. The station's flash is erased only when
 * the whole record was read, every slot was decoded, the import succeeded and
 * the operator asked for auto-clear. Anything else leaves the flash alone.
 */
export type BackupFlowOutcome<R> =
  | { outcome: "incomplete"; error: BackupReadIncompleteError }
  | { outcome: "not-imported"; backup: BackupResult }
  | { outcome: "import-failed"; backup: BackupResult; error: unknown }
  | {
      outcome: "done";
      backup: BackupResult;
      imported: R;
      skippedSlots: SkippedBackupSlot[];
      cleared: boolean;
    };

export async function runBackupFlow<R>(deps: {
  read: () => Promise<BackupResult>;
  /** Import the records. Return null when nothing was imported on purpose (e.g. unknown control). */
  importBackup: (backup: BackupResult) => Promise<R | null>;
  clear: () => Promise<void>;
  autoClear: boolean;
}): Promise<BackupFlowOutcome<R>> {
  let backup: BackupResult;
  try {
    backup = await deps.read();
  } catch (err) {
    if (err instanceof BackupReadIncompleteError) return { outcome: "incomplete", error: err };
    throw err;
  }
  let imported: R | null;
  try {
    imported = await deps.importBackup(backup);
  } catch (error) {
    return { outcome: "import-failed", backup, error };
  }
  if (imported === null) return { outcome: "not-imported", backup };
  const skippedSlots = backup.mode === "readout" ? backup.skippedSlots : [];
  let cleared = false;
  if (deps.autoClear && skippedSlots.length === 0) {
    try {
      await deps.clear();
      cleared = true;
    } catch {
      console.warn("Failed to clear backup memory after read");
    }
  }
  return { outcome: "done", backup, imported, skippedSlots, cleared };
}

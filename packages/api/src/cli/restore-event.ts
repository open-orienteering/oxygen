/**
 * Restore a per-event backup (the Event page's Download backup file) into
 * this database (docs/ops/backup-restore.md "Restoring an event"):
 *
 *   pnpm event:restore <backup.sql> [--replace]
 *   docker exec <api> node packages/api/dist/cli/restore-event.js <backup.sql> [--replace]   (inside the image)
 *
 * Reads DATABASE_URL (from .env in packages/api when present); the
 * database must be on the current schema (`pnpm db:migrate`). Refuses
 * when the event already exists here, unless `--replace`, which deletes
 * it first. Exits 0 on success, 1 when the restore failed, 2 on bad
 * arguments.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RestoreError, runRestore } from "../restore.js";

const USAGE = "usage: event-restore <backup.sql> [--replace]";
const argv = process.argv.slice(2);
const replace = argv.includes("--replace");
const files = argv.filter((a) => a !== "--replace");
if (files.length !== 1 || files[0].startsWith("--")) {
  console.error(USAGE);
  process.exit(2);
}

// `pnpm event:restore` runs in packages/api: a relative path is the caller's.
const file = resolve(process.env.INIT_CWD ?? process.cwd(), files[0]);
let text: string;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  console.error(`cannot read ${file}: ${(err as Error).message}`);
  process.exit(2);
}

try {
  const result = runRestore(text, {
    replace,
    onPhase: (label, stderr) => {
      console.log(`restored: ${label}`);
      for (const line of stderr.split("\n")) if (line.trim()) console.log(`  ${line}`);
    },
  });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  for (const n of result.notes) console.log(`next: ${n}`);
  console.log(`done: the event is restored as event id ${result.eventId}`);
  process.exit(0);
} catch (err) {
  if (err instanceof RestoreError) {
    console.error(`restore failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

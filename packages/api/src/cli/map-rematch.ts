/**
 * Re-match stored map documents that are stale — imported by an older
 * importer, against an older library release, or (club editions) before
 * the current club symbol decisions (docs/map-storage.md §6.9):
 *
 *   pnpm map:rematch [--event <nameId>] [--limit <n>] [--dry-run]
 *   docker exec <api> node packages/api/dist/cli/map-rematch.js …   (inside the image)
 *
 * Reads DATABASE_URL (from .env in packages/api when present). Prints
 * one line per pin and a summary; exits 1 if any failed, 2 on bad
 * arguments. A second run finds nothing left to do. `--event` restricts
 * the pass to that event's pins (club editions are then skipped).
 */

import "dotenv/config";
import { prisma } from "../db.js";
import { formatPlanLine, formatRematchLine, formatRematchSummary, parseRematchArgs } from "./map-rematch-args.js";
import { runRematch } from "../map-store/rematch.js";

const parsed = parseRematchArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error("usage: map-rematch [--event <nameId>] [--limit <n>] [--dry-run]");
  process.exit(2);
}
const args = parsed.value;
const db = prisma();

let eventId: bigint | null = null;
if (args.event) {
  const event = await db.event.findUnique({ where: { nameId: args.event }, select: { id: true } });
  if (!event) {
    console.error(`event ${args.event} not found`);
    process.exit(2);
  }
  eventId = event.id;
}

const run = await runRematch(db, {
  eventId,
  limit: args.limit,
  dryRun: args.dryRun,
  onPlan: (items) => {
    console.log(`stale: ${items.length} pin(s)${args.dryRun ? " (dry run)" : ""}`);
    if (args.dryRun) for (const item of items) console.log(formatPlanLine(item));
  },
  onItem: (result, live) => console.log(formatRematchLine(result, live)),
});
console.log(formatRematchSummary(run));
await db.$disconnect();
process.exit(run.failed === 0 ? 0 : 1);

/**
 * Backfill pre-pipeline map rows into the document store
 * (docs/map-storage.md §6.7):
 *
 *   pnpm map:backfill [--event <nameId>] [--limit <n>] [--dry-run]
 *   docker exec <api> node packages/api/dist/cli/map-backfill.js …   (inside the image)
 *
 * Reads DATABASE_URL (from .env in packages/api when present). Prints
 * one line per map and a summary; exits 1 if any map failed, 2 on bad
 * arguments. Safe to re-run: finished maps are not touched again.
 */

import "dotenv/config";
import { prisma } from "../db.js";
import { parseBackfillArgs, formatItemLine, formatSummary } from "./map-backfill-args.js";
import { runBackfill } from "../map-store/backfill.js";

const parsed = parseBackfillArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error("usage: map-backfill [--event <nameId>] [--limit <n>] [--dry-run]");
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

const run = await runBackfill(db, {
  eventId,
  limit: args.limit,
  dryRun: args.dryRun,
  onPlan: (plan, items) => {
    console.log(`pending: ${plan.clubRows} club map(s), ${plan.eventRows} event map(s); this run: ${items.length}${args.dryRun ? " (dry run)" : ""}`);
    if (args.dryRun) for (const item of items) console.log(`  ${item.kind} #${item.id} ${item.name}`);
  },
  onItem: (result, live) => console.log(formatItemLine(result, live)),
});
console.log(formatSummary(run));
await db.$disconnect();
process.exit(run.state === "done" && run.failed === 0 ? 0 : 1);

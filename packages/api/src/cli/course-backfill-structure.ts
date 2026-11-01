/**
 * Fill `courses.structure` where it is NULL (docs/course-layer.md §6.4;
 * research 09 §5):
 *
 *   pnpm course:backfill-structure [--event <nameId>] [--dry-run] [--out <dir>]
 *   docker exec <api> node packages/api/dist/cli/course-backfill-structure.js …   (inside the image)
 *
 * Reads DATABASE_URL (from .env in packages/api when present). Prints one
 * line per course (with the regenerated-vs-stored comparison) and a summary;
 * `--out` also writes `report.json` there. Exits 1 if any course failed, 2
 * on bad arguments. Safe to re-run: filled courses are not touched again.
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { prisma } from "../db.js";
import { parseCourseBackfillArgs, formatCourseLine, formatCourseSummary } from "./course-backfill-args.js";
import { runStructureBackfill } from "../course-structure-backfill.js";

const parsed = parseCourseBackfillArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error("usage: course-backfill-structure [--event <nameId>] [--dry-run] [--out <dir>]");
  process.exit(2);
}
const args = parsed.value;
const db = prisma();

let eventId: bigint | undefined;
if (args.event) {
  const event = await db.event.findUnique({ where: { nameId: args.event }, select: { id: true } });
  if (!event) {
    console.error(`event ${args.event} not found`);
    process.exit(2);
  }
  eventId = event.id;
}

const run = await runStructureBackfill(db, {
  eventId,
  dryRun: args.dryRun,
  onCourse: (r, n, total) => console.log(formatCourseLine(r, n, total)),
});
console.log(formatCourseSummary(run, args.dryRun));
if (args.out) {
  await mkdir(args.out, { recursive: true });
  await writeFile(`${args.out}/report.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...run }, null, 2));
  console.log(`report: ${args.out}/report.json`);
}
await db.$disconnect();
process.exit(run.failed === 0 ? 0 : 1);

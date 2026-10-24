/**
 * The `courses.geometry` comparison report (docs/course-layer.md §4
 * "Comparison"): for every event in the database, the stored editor
 * geometry vs what the course layer writes now, cut by cut, and the
 * legacy-geometry fidelity of imported courses (09 §10). Read-only.
 *
 *   pnpm --filter @oxygen/api geometry:compare [--event <nameId>]… [--out <dir>]
 *
 * Reads DATABASE_URL like the server. Writes `report.md` and
 * `courses.json` to `<dir>` (default `.local/course-geometry/<date>/` at
 * the repository root — never committed) and prints the Markdown.
 * Run it from the main checkout: the dev database is off limits from a
 * worktree.
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/db.js";
import { buildGeometryReport, formatGeometryReport } from "../src/course-geometry-report.js";

const args = process.argv.slice(2);
const events: string[] = [];
let out: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--event" && args[i + 1]) events.push(args[++i]);
  else if (args[i] === "--out" && args[i + 1]) out = args[++i];
  else {
    console.error("usage: compare-course-geometry [--event <nameId>]… [--out <dir>]");
    process.exit(2);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = resolve(out ?? `${root}/.local/course-geometry/${new Date().toISOString().slice(0, 10)}`);
const db = prisma();
try {
  const report = await buildGeometryReport(db, events.length ? { eventNameIds: events } : {});
  const md = formatGeometryReport(report);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/report.md`, md);
  await writeFile(`${dir}/courses.json`, JSON.stringify(report, null, 1));
  console.log(md);
  console.log(`wrote ${dir}/report.md and courses.json`);
} finally {
  await db.$disconnect();
}

#!/usr/bin/env node
/**
 * The Demo Competition's showcase course (docs/ops/demo.md, "The showcase
 * course"):
 *
 *   DATABASE_URL=… node scripts/showcase-course.mjs export [--event demo_competition]
 *       Read the course named "Showcase", its variants, sheets, the
 *       event's course objects and the controls that are not the race's
 *       from a loaded demo event, and write fixtures/showcase/showcase-course.sql.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pgClient } from "./lib/showcase-controls.mjs";
import { COURSE_SQL_PATH, exportShowcaseCourse, raceControlSeqs } from "./lib/showcase-course.mjs";
import { FIXTURE_PATH } from "./lib/showcase-sql.mjs";

const [command, ...rest] = process.argv.slice(2);
if (command !== "export") {
  console.error("usage: showcase-course.mjs export [--event <nameId>]");
  process.exit(2);
}
const i = rest.indexOf("--event");
const nameId = i >= 0 ? rest[i + 1] : "demo_competition";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("export reads DATABASE_URL");
const client = pgClient(url);
await client.connect();
try {
  const sql = await exportShowcaseCourse(client, raceControlSeqs(readFileSync(FIXTURE_PATH, "utf8")), nameId);
  writeFileSync(COURSE_SQL_PATH, sql);
  console.log(`wrote ${COURSE_SQL_PATH} (${sql.split("\n").filter((l) => l.startsWith("INSERT")).length} rows)`);
} finally {
  await client.end();
}

/**
 * The Demo Competition's showcase course (docs/ops/demo.md, "The showcase
 * course"): a course set in the course editor to show what it can do —
 * a fork, a butterfly loop, a corridor, a marked route, an out-of-bounds
 * area and its printed sheet — kept apart from the race data in
 * `fixtures/showcase/showcase-course.sql`.
 *
 * The file is not written by hand. `export` reads the course from a
 * database where it was edited and writes every row it needs, so a
 * tweak in the editor reaches the fixture with one command:
 *
 *   - the controls that are not the race's (seq not in showcase.sql);
 *   - the course named `Showcase` and its variants (the forks' child courses);
 *   - their `course_controls` and `course_maps` (sheets);
 *   - the event's `course_objects` (the race has none).
 *
 * Each row is one `INSERT … SELECT * FROM json_populate_record(…)` line, so
 * the file follows the schema without a column list. `load-showcase.sh`
 * runs it after showcase.sql (which deletes and re-creates the event)
 * and before the map re-match, which derives the controls' lat / lng.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFixtureRows } from "./showcase-controls.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COURSE_SQL_PATH = path.join(ROOT, "fixtures", "showcase", "showcase-course.sql");
export const SHOWCASE_COURSE_NAME = "Showcase";
export const DEMO_EVENT_NAME_ID = "demo_competition";

/** Columns written as given by the database but not kept: lat / lng follow the pin on load. */
const CLEARED = { controls: ["lat", "lng"] };

/** One row as a load-anywhere INSERT: the row's JSON, typed by the table's own record type. */
export function rowInsert(table, row) {
  const r = { ...row };
  for (const c of CLEARED[table] ?? []) if (c in r) r[c] = null;
  const json = JSON.stringify(r).replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::oxygen.${table}, E'${json}');`;
}

/**
 * The rows of the showcase course in event `nameId`, read through `client`
 * (a `pg` client), as the file's text. `raceSeqs` are the race's control
 * seqs (showcase.sql's), which stay in that file.
 */
export async function exportShowcaseCourse(client, raceSeqs, nameId = DEMO_EVENT_NAME_ID) {
  const q = async (text, params) => (await client.query(text, params)).rows.map((r) => r.row);
  const event = (await client.query(`SELECT id FROM oxygen.events WHERE name_id = $1`, [nameId])).rows[0];
  if (!event) throw new Error(`No event ${nameId}`);
  const id = String(event.id);
  const courses = await q(
    `SELECT to_jsonb(c) AS row FROM oxygen.courses c
      WHERE c.event_id = $1 AND (c.name = $2 AND c.parent_course_id IS NULL
         OR c.parent_course_id IN (SELECT p.id FROM oxygen.courses p WHERE p.event_id = $1 AND p.name = $2 AND p.parent_course_id IS NULL))
      ORDER BY c.parent_course_id NULLS FIRST, c.seq`,
    [id, SHOWCASE_COURSE_NAME],
  );
  if (!courses.some((c) => c.parent_course_id === null)) throw new Error(`No course named ${SHOWCASE_COURSE_NAME} in ${nameId}`);
  const courseIds = courses.map((c) => c.id);
  const controls = (await q(`SELECT to_jsonb(c) AS row FROM oxygen.controls c WHERE c.event_id = $1 ORDER BY c.seq`, [id])).filter(
    (c) => !raceSeqs.has(Number(c.seq)),
  );
  const courseControls = await q(
    `SELECT to_jsonb(cc) AS row FROM oxygen.course_controls cc WHERE cc.course_id = ANY($1::uuid[]) ORDER BY cc.course_id, cc.position`,
    [courseIds],
  );
  const objects = await q(`SELECT to_jsonb(o) AS row FROM oxygen.course_objects o WHERE o.event_id = $1 ORDER BY o.seq`, [id]);
  const sheets = await q(`SELECT to_jsonb(m) AS row FROM oxygen.course_maps m WHERE m.course_id = ANY($1::uuid[]) ORDER BY m.seq`, [courseIds]);
  // A sheet's template is the instance's, not the event's: it is not in the fixture.
  for (const s of sheets) s.template_id = null;

  return [
    "-- The Demo Competition's showcase course (scripts/lib/showcase-course.mjs).",
    "-- Do not edit by hand: edit the course in the course editor, then",
    "--   DATABASE_URL=… node scripts/showcase-course.mjs export",
    "-- Loaded by scripts/load-showcase.sh after showcase.sql.",
    "",
    "SET search_path = oxygen;",
    "BEGIN;",
    "",
    `-- ─── controls (${controls.length}, the race's are in showcase.sql) ───`,
    ...controls.map((r) => rowInsert("controls", r)),
    "",
    `-- ─── courses (${courses.length}: the course and its variants) ───`,
    ...courses.map((r) => rowInsert("courses", r)),
    "",
    `-- ─── course_controls (${courseControls.length}) ───`,
    ...courseControls.map((r) => rowInsert("course_controls", r)),
    "",
    `-- ─── course_objects (${objects.length}) ───`,
    ...objects.map((r) => rowInsert("course_objects", r)),
    "",
    `-- ─── course_maps (${sheets.length}, the course's sheets) ───`,
    ...sheets.map((r) => rowInsert("course_maps", r)),
    "",
    "COMMIT;",
    "",
  ].join("\n");
}

/** The race's control seqs: the controls showcase.sql writes. */
export function raceControlSeqs(showcaseSql) {
  return new Set(readFixtureRows(showcaseSql).controls.map((c) => Number(c.seq)));
}

/** The rows of a showcase-course file, by table, parsed back from its JSON. */
export function readCourseSql(sql) {
  const out = { controls: [], courses: [], course_controls: [], course_objects: [], course_maps: [] };
  const re = /^INSERT INTO (\w+) SELECT \* FROM json_populate_record\(NULL::oxygen\.\w+, E'(.*)'\);$/;
  for (const line of sql.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    out[m[1]].push(JSON.parse(m[2].replace(/''/g, "'").replace(/\\\\/g, "\\")));
  }
  return out;
}

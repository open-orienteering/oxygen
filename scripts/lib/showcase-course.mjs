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

/** Tables whose rows the file writes over showcase.sql's own (same id): the race's controls and courses. */
const UPSERT = new Set(["controls", "courses"]);

/**
 * One row as a load-anywhere INSERT: the row's JSON, typed by the table's own
 * record type; for `UPSERT` tables an upsert on `id`, every other column taken.
 */
export function rowInsert(table, row) {
  const r = { ...row };
  for (const c of CLEARED[table] ?? []) if (c in r) r[c] = null;
  const json = JSON.stringify(r).replace(/\\/g, "\\\\").replace(/'/g, "''");
  const insert = `INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::oxygen.${table}, E'${json}')`;
  if (!UPSERT.has(table)) return `${insert};`;
  const cols = Object.keys(r).filter((c) => c !== "id");
  return `${insert} ON CONFLICT (id) DO UPDATE SET (${cols.join(", ")}) = ROW(${cols.map((c) => `EXCLUDED.${c}`).join(", ")});`;
}

/**
 * The course state of event `nameId`, read through `client` (a `pg`
 * client), as the file's text: every control and course (an upsert over
 * the race's rows in showcase.sql, so a code, a position or a start set
 * in the editor wins), every course's `course_controls` (replacing
 * showcase.sql's), the course objects and the sheets, and the event's seq
 * counters raised past every row. `raceSeqs` (showcase.sql's control
 * seqs) only label the counts.
 */
export async function exportShowcaseCourse(client, raceSeqs, nameId = DEMO_EVENT_NAME_ID) {
  const q = async (text, params) => (await client.query(text, params)).rows.map((r) => r.row);
  const event = (await client.query(`SELECT id FROM oxygen.events WHERE name_id = $1`, [nameId])).rows[0];
  if (!event) throw new Error(`No event ${nameId}`);
  const id = String(event.id);
  const courses = await q(
    `SELECT to_jsonb(c) AS row FROM oxygen.courses c WHERE c.event_id = $1 ORDER BY c.parent_course_id NULLS FIRST, c.seq`,
    [id],
  );
  if (!courses.some((c) => c.parent_course_id === null && c.name === SHOWCASE_COURSE_NAME && !c.removed)) {
    throw new Error(`No course named ${SHOWCASE_COURSE_NAME} in ${nameId}`);
  }
  const courseIds = courses.map((c) => c.id);
  const controls = await q(`SELECT to_jsonb(c) AS row FROM oxygen.controls c WHERE c.event_id = $1 ORDER BY c.seq`, [id]);
  const courseControls = await q(
    `SELECT to_jsonb(cc) AS row FROM oxygen.course_controls cc WHERE cc.course_id = ANY($1::uuid[]) ORDER BY cc.course_id, cc.position`,
    [courseIds],
  );
  const objects = await q(`SELECT to_jsonb(o) AS row FROM oxygen.course_objects o WHERE o.event_id = $1 ORDER BY o.seq`, [id]);
  const sheets = await q(`SELECT to_jsonb(m) AS row FROM oxygen.course_maps m WHERE m.course_id = ANY($1::uuid[]) ORDER BY m.seq`, [courseIds]);
  // A sheet's template is the instance's, not the event's: it is not in the fixture.
  for (const s of sheets) s.template_id = null;
  const race = controls.filter((c) => raceSeqs.has(Number(c.seq))).length;

  return [
    "-- The Demo Competition's courses as set in the course editor (scripts/lib/showcase-course.mjs).",
    "-- Do not edit by hand: edit the courses in the course editor, then",
    "--   DATABASE_URL=… node scripts/showcase-course.mjs export",
    "-- Loaded by scripts/load-showcase.sh after showcase.sql, over its controls and courses.",
    "",
    "SET search_path = oxygen;",
    "BEGIN;",
    "",
    `-- ─── controls (${controls.length}: ${race} the race's, written over showcase.sql's) ───`,
    ...controls.map((r) => rowInsert("controls", r)),
    "",
    `-- ─── courses (${courses.length}: the race's, the showcase course and its variants) ───`,
    ...courses.map((r) => rowInsert("courses", r)),
    "",
    `-- ─── course_controls (${courseControls.length}, in place of showcase.sql's) ───`,
    `DELETE FROM course_controls WHERE course_id IN (SELECT id FROM courses WHERE event_id = ${id});`,
    ...courseControls.map((r) => rowInsert("course_controls", r)),
    "",
    `-- ─── course_objects (${objects.length}) ───`,
    ...objects.map((r) => rowInsert("course_objects", r)),
    "",
    `-- ─── course_maps (${sheets.length}, the courses' sheets) ───`,
    ...sheets.map((r) => rowInsert("course_maps", r)),
    "",
    "-- ─── the seq counters, past every row above ───",
    ...["controls", "courses", "course_objects", "course_maps"].map(
      (t) =>
        `INSERT INTO event_seqs (event_id, table_name, next_seq) SELECT ${id}, '${t}', COALESCE(max(seq), 0) + 1 FROM ${t} WHERE event_id = ${id} ` +
        `ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = GREATEST(event_seqs.next_seq, EXCLUDED.next_seq);`,
    ),
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
  const re = /^INSERT INTO (\w+) SELECT \* FROM json_populate_record\(NULL::oxygen\.\w+, E'(.*?)'\)(?: ON CONFLICT \(id\) DO UPDATE SET \([\w, ]+\) = ROW\([\w., ]+\))?;$/;
  for (const line of sql.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    out[m[1]].push(JSON.parse(m[2].replace(/''/g, "'").replace(/\\\\/g, "\\")));
  }
  return out;
}

/**
 * `structure` (a wire structure: site ids are public control ids) with
 * `start` and `finish` as its explicit start and finish, or null when it
 * already has them. A leading item whose site is in `startIds` (any start)
 * is replaced, else `start` is put first — unless the first control is
 * the start (`role: "start"`); the finish likewise at the end. The leg
 * into a replaced finish is kept.
 */
export function withEnds(structure, { start, finish, startIds, finishIds }) {
  const items = [...structure.items];
  let changed = false;
  const first = items[0];
  const isControl = (item) => item && item.kind !== "variation";
  if (isControl(first) && startIds.has(first.siteId)) {
    if (first.siteId !== start) {
      items[0] = { ...first, siteId: start };
      changed = true;
    }
  } else if (!(isControl(first) && first.role === "start")) {
    items.unshift({ siteId: start });
    changed = true;
  }
  const lastIndex = items.length - 1;
  const last = items[lastIndex];
  if (isControl(last) && finishIds.has(last.siteId)) {
    if (last.siteId !== finish) {
      items[lastIndex] = { ...last, siteId: finish };
      changed = true;
    }
  } else if (!(isControl(last) && last.role === "finish")) {
    items.push({ siteId: finish });
    changed = true;
  }
  return changed ? { ...structure, items } : null;
}

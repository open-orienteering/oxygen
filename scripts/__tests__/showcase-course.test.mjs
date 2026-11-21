import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COURSE_SQL_PATH, exportShowcaseCourse, raceControlSeqs, readCourseSql, rowInsert } from "../lib/showcase-course.mjs";
import { readFixtureRows } from "../lib/showcase-controls.mjs";
import { FIXTURE_PATH, FORBIDDEN_SHOWCASE_SQL } from "../lib/showcase-sql.mjs";

// The Demo Competition's showcase course (docs/ops/demo.md, "The showcase course").
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("showcase course rows", () => {
  it("writes a row as one json_populate_record line that reads back the same, quotes and backslashes included", () => {
    const row = { id: "x", name: "it's a \\ test", structure: { items: [{ siteId: "a" }] }, lat: 59.1, lng: 18.1 };
    const line = rowInsert("courses", row);
    assert.equal(line.includes("\n"), false);
    assert.match(line, /^INSERT INTO courses SELECT \* FROM json_populate_record\(NULL::oxygen\.courses, E'/);
    assert.deepEqual(readCourseSql(line).courses, [row]);
    assert.deepEqual(readCourseSql(rowInsert("controls", { id: "c", lat: 1, lng: 2 })).controls, [{ id: "c", lat: null, lng: null }], "lat / lng follow the pin");
  });

  it("exports the course, its variants, their controls, objects and sheets, and only the controls that are not the race's", async () => {
    const rows = {
      event: [{ id: "42" }],
      courses: [{ row: { id: "k", name: "Showcase", parent_course_id: null } }, { row: { id: "v", name: "Showcase AB", parent_course_id: "k" } }],
      controls: [{ row: { id: "r", seq: 31, lat: 1, lng: 1 } }, { row: { id: "n", seq: 500, lat: 1, lng: 1 } }],
      course_controls: [{ row: { course_id: "k", position: 1, control_id: "n" } }],
      course_objects: [{ row: { id: "o", kind: "oob_area" } }],
      course_maps: [{ row: { id: "m", course_id: "k", template_id: "t" } }],
    };
    const seen = [];
    const client = {
      async query(text, params) {
        seen.push(params);
        const table = /FROM oxygen\.(\w+)/.exec(text)[1];
        return { rows: table === "events" ? rows.event : rows[table] };
      },
    };
    const sql = await exportShowcaseCourse(client, new Set([31]), "demo_competition");
    const back = readCourseSql(sql);
    assert.deepEqual(back.controls.map((c) => c.id), ["n"]);
    assert.deepEqual(back.courses.map((c) => c.id), ["k", "v"]);
    assert.equal(back.course_controls.length, 1);
    assert.equal(back.course_objects.length, 1);
    assert.equal(back.course_maps[0].template_id, null, "the instance's template is not the fixture's");
    assert.deepEqual(seen[0], ["demo_competition"]);
    assert.match(sql, /^-- The Demo Competition's showcase course/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;\n$/);
    await assert.rejects(exportShowcaseCourse({ query: async () => ({ rows: [] }) }, new Set(), "nope"), /No event nope/);
  });
});

describe("committed showcase-course.sql", () => {
  const sql = readFileSync(COURSE_SQL_PATH, "utf8");
  const rows = readCourseSql(sql);
  const race = readFixtureRows(readFileSync(FIXTURE_PATH, "utf8"));

  it("holds the Showcase course, its variants and its sheet, all in the demo event", () => {
    const [root, ...variants] = rows.courses;
    assert.equal(root.name, "Showcase");
    assert.equal(root.parent_course_id, null);
    assert.ok(variants.length > 0 && variants.every((v) => v.parent_course_id === root.id));
    assert.ok(rows.course_maps.some((m) => m.course_id === root.id));
    for (const t of ["controls", "courses", "course_objects", "course_maps"]) for (const r of rows[t]) assert.equal(String(r.event_id), "9876543", `${t} ${r.id}`);
    assert.equal(sql.split("\n").filter((l) => l.startsWith("INSERT")).length, Object.values(rows).flat().length, "every INSERT parses");
  });

  it("names only controls that one of the two files writes, and none of the race's twice", () => {
    const raceIds = new Set(race.controls.map((c) => c.id));
    const ownIds = new Set(rows.controls.map((c) => c.id));
    const raceSeqs = raceControlSeqs(readFileSync(FIXTURE_PATH, "utf8"));
    for (const c of rows.controls) assert.equal(raceSeqs.has(Number(c.seq)), false, `seq ${c.seq} is the race's`);
    const known = (id) => raceIds.has(id) || ownIds.has(id);
    for (const cc of rows.course_controls) assert.ok(known(cc.control_id), cc.control_id);
    const sites = JSON.stringify(rows.courses.map((c) => c.structure)).match(/"siteId":"([^"]+)"/g) ?? [];
    assert.ok(sites.length > 10);
    for (const s of sites) assert.ok(known(s.slice(10, -1)), s);
  });

  it("names nothing of the source map or its club", () => {
    for (const re of FORBIDDEN_SHOWCASE_SQL) assert.equal(re.test(sql), false, `matched ${re}`);
  });

  it("is loaded by load-showcase.sh after showcase.sql, in the same psql session", () => {
    const loader = readFileSync(path.join(ROOT, "scripts", "load-showcase.sh"), "utf8");
    assert.match(loader, /COURSE_FIXTURE="\$REPO_ROOT\/fixtures\/showcase\/showcase-course\.sql"/);
    assert.match(loader, /cat "\$FIXTURE"\n\s*printf "\\n"\n\s*cat "\$COURSE_FIXTURE"/);
  });
});

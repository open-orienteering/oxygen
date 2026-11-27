import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COURSE_SQL_PATH, exportShowcaseCourse, raceControlSeqs, readCourseSql, rowInsert, withEnds } from "../lib/showcase-course.mjs";
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

  it("writes controls and courses over showcase.sql's rows (an upsert on id), the rest as plain inserts", () => {
    assert.match(rowInsert("courses", { id: "x", name: "A", seq: 1 }), /\) ON CONFLICT \(id\) DO UPDATE SET \(name, seq\) = ROW\(EXCLUDED\.name, EXCLUDED\.seq\);$/);
    assert.match(rowInsert("controls", { id: "c", codes: "5" }), /ON CONFLICT \(id\) DO UPDATE SET \(codes, lat, lng\)|ON CONFLICT \(id\) DO UPDATE SET \(codes\)/);
    assert.doesNotMatch(rowInsert("course_objects", { id: "o" }), /ON CONFLICT/);
    assert.doesNotMatch(rowInsert("course_controls", { course_id: "k", position: 1 }), /ON CONFLICT/);
  });

  it("exports every control and course, the course controls in place of showcase.sql's, objects, sheets and the seq counters", async () => {
    const rows = {
      event: [{ id: "42" }],
      courses: [
        { row: { id: "a", name: "A", parent_course_id: null } },
        { row: { id: "k", name: "Showcase", parent_course_id: null } },
        { row: { id: "v", name: "Showcase AB", parent_course_id: "k" } },
      ],
      controls: [{ row: { id: "r", seq: 31, lat: 1, lng: 1 } }, { row: { id: "n", seq: 500, lat: 1, lng: 1 } }],
      course_controls: [{ row: { course_id: "k", position: 1, control_id: "n" } }, { row: { course_id: "a", position: 1, control_id: "r" } }],
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
    assert.deepEqual(back.controls.map((c) => c.id), ["r", "n"], "the race's controls too: a code or position set in the editor");
    assert.deepEqual(back.courses.map((c) => c.id), ["a", "k", "v"]);
    assert.equal(back.course_controls.length, 2);
    const del = sql.indexOf("DELETE FROM course_controls WHERE course_id IN (SELECT id FROM courses WHERE event_id = 42);");
    assert.ok(del > sql.indexOf("INSERT INTO courses") && del < sql.indexOf("INSERT INTO course_controls"), "showcase.sql's course controls go before the editor's");
    assert.equal(back.course_objects.length, 1);
    assert.equal(back.course_maps[0].template_id, null, "the instance's template is not the fixture's");
    for (const t of ["controls", "courses", "course_objects", "course_maps"]) {
      assert.match(sql, new RegExp(`INSERT INTO event_seqs \\(event_id, table_name, next_seq\\) SELECT 42, '${t}', COALESCE\\(max\\(seq\\), 0\\) \\+ 1 FROM ${t} WHERE event_id = 42 ON CONFLICT`));
    }
    assert.deepEqual(seen[0], ["demo_competition"]);
    assert.match(sql, /^-- The Demo Competition's courses/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;\n$/);
    await assert.rejects(exportShowcaseCourse({ query: async () => ({ rows: [] }) }, new Set(), "nope"), /No event nope/);
    rows.courses = [rows.courses[0]];
    await assert.rejects(exportShowcaseCourse(client, new Set(), "demo_competition"), /No course named Showcase/);
  });
});

describe("withEnds", () => {
  const ends = { start: 5, finish: 6, startIds: new Set([3, 5]), finishIds: new Set([4, 6]) };
  const s = (items) => ({ version: 1, id: "c", orderMode: "ordered", items });

  it("replaces another start and finish, keeping the leg into the finish", () => {
    const leg = { style: "marked_route" };
    assert.deepEqual(withEnds(s([{ siteId: 3 }, { siteId: 101 }, { siteId: 4, leg }]), ends).items, [{ siteId: 5 }, { siteId: 101 }, { siteId: 6, leg }]);
  });

  it("adds a missing start and finish, and leaves a course already right alone", () => {
    assert.deepEqual(withEnds(s([{ siteId: 101 }]), ends).items, [{ siteId: 5 }, { siteId: 101 }, { siteId: 6 }]);
    assert.deepEqual(withEnds(s([]), ends).items, [{ siteId: 5 }, { siteId: 6 }]);
    assert.equal(withEnds(s([{ siteId: 5 }, { siteId: 101 }, { siteId: 6 }]), ends), null);
  });

  it("keeps a first control run as the start and a last as the finish", () => {
    const items = [{ siteId: 101, role: "start" }, { siteId: 102, role: "finish" }];
    assert.equal(withEnds(s(items), ends), null);
  });

  it("puts the start before a leading variation group's anchor", () => {
    const group = { kind: "variation", id: "g", alternatives: [{ label: "A", items: [] }, { label: "B", items: [] }] };
    assert.deepEqual(withEnds(s([{ siteId: 101 }, group, { siteId: 102 }]), ends).items, [{ siteId: 5 }, { siteId: 101 }, group, { siteId: 102 }, { siteId: 6 }]);
  });
});

describe("committed showcase-course.sql", () => {
  const sql = readFileSync(COURSE_SQL_PATH, "utf8");
  const rows = readCourseSql(sql);
  const race = readFixtureRows(readFileSync(FIXTURE_PATH, "utf8"));

  it("holds the race's courses, the Showcase course, its variants and its sheet, all in the demo event", () => {
    const root = rows.courses.find((c) => c.name === "Showcase" && c.parent_course_id === null);
    assert.ok(root);
    const variants = rows.courses.filter((c) => c.parent_course_id === root.id);
    assert.ok(variants.length > 0);
    for (const c of race.courses) assert.ok(rows.courses.some((r) => r.id === c.id), `race course ${c.name}`);
    assert.ok(rows.course_maps.some((m) => m.course_id === root.id));
    for (const t of ["controls", "courses", "course_objects", "course_maps"]) for (const r of rows[t]) assert.equal(String(r.event_id), "9876543", `${t} ${r.id}`);
    const inserts = sql.split("\n").filter((l) => l.startsWith("INSERT") && !l.startsWith("INSERT INTO event_seqs"));
    assert.equal(inserts.length, Object.values(rows).flat().length, "every INSERT parses");
  });

  it("writes every race control over showcase.sql's and names only controls the file writes", () => {
    const ownIds = new Set(rows.controls.map((c) => c.id));
    for (const c of race.controls) assert.ok(ownIds.has(c.id), `race control seq ${c.seq}`);
    for (const cc of rows.course_controls) assert.ok(ownIds.has(cc.control_id), cc.control_id);
    const sites = JSON.stringify(rows.courses.map((c) => c.structure)).match(/"siteId":"([^"]+)"/g) ?? [];
    assert.ok(sites.length > 10);
    for (const s of sites) assert.ok(ownIds.has(s.slice(10, -1)), s);
  });

  it("gives every live start and finish a code, the Showcase course its own and every other course the race's", () => {
    const raceSeqs = raceControlSeqs(readFileSync(FIXTURE_PATH, "utf8"));
    const ends = rows.controls.filter((c) => !c.removed && (c.status === "start" || c.status === "finish"));
    for (const c of ends) assert.match(c.codes, /^\d+/, `${c.name} has a code`);
    const codes = rows.controls.filter((c) => !c.removed).map((c) => c.codes.split(";")[0]).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length, "no two live controls share a code");
    const pick = (status, isRace) => ends.filter((c) => c.status === status && raceSeqs.has(Number(c.seq)) === isRace);
    for (const [status, isRace] of [["start", true], ["start", false], ["finish", true], ["finish", false]]) assert.equal(pick(status, isRace).length, 1, `${status} race=${isRace}`);
    for (const c of rows.courses.filter((r) => !r.removed && r.parent_course_id === null)) {
      const own = c.name === "Showcase";
      const [start] = pick("start", !own);
      const [finish] = pick("finish", !own);
      assert.equal(c.start_name, start.name, `${c.name} starts at ${start.name}`);
      assert.equal(c.finish_control_id, finish.id, `${c.name} finishes at ${finish.name}`);
      const items = c.structure?.items ?? [];
      assert.equal(items[0]?.siteId, start.id, `${c.name}'s structure starts at ${start.name}`);
      assert.equal(items.at(-1)?.siteId, finish.id, `${c.name}'s structure finishes at ${finish.name}`);
    }
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

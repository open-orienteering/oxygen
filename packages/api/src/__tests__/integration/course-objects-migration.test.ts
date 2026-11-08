/**
 * The F12 migration (docs/course-layer.md §3.6 "Migration (F12)";
 * docs/migrations/2026-f12-map-anchored-objects.md): map-anchored layout
 * objects of templates and sheets become `course_objects` rows.
 *
 * As the E5 test does, on a scratch database built up to the migration
 * before F12 (each earlier `migration.sql`, in order), seeded with legacy
 * rows of every shape, then given the F12 file the way Prisma runs it: one
 * transaction, all or nothing. The mapping per kind, the scope per row
 * type, the guard (refuses, changes nothing), soft-deleted events, the
 * club payloads and a second run (changes nothing) are asserted on the
 * rows; `course-print.test.ts` "F12" draws a migrated sheet.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { course } from "@oxygen/shared";

const MIGRATIONS = resolve(__dirname, "../../../prisma/migrations");
const F12 = "20261109120000_map_anchored_objects_to_course_objects";

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.searchParams.delete("schema");
const scratchName = `${testUrl.pathname.replace(/^\//, "")}_f12objects`;
const scratchUrl = new URL(testUrl.toString());
scratchUrl.pathname = `/${scratchName}`;

let db: Client;
const ids = {} as {
  live: string; nomap: string; removed: string;
  course: string; cls: string; template: string; purpleTemplate: string;
  courseSheet: string; classSheet: string; allSheet: string; setterSheet: string; setterCourseSheet: string; bareSheet: string; nomapSheet: string;
  removedSheet: string;
};

async function admin<T>(f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: testUrl.toString() });
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.end();
  }
}

/** Run the F12 migration as Prisma does: the whole file in one transaction. */
async function applyF12(): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS, F12, "migration.sql"), "utf8");
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => (await db.query(sql, params)).rows[0] as T;
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(`${sql} RETURNING id`, params)).id;

// Map-anchored legacy objects (the pre-F12 `courseMapObjectSchema` shape).
const purpleHatch = { id: "t-oob-dashed", anchor: "map", kind: "path", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }], fillMode: "outOfBounds", closed: true, stroke: "#a626ff", strokeWidthMm: 0.3, dash: "dashed" };
const templateObjects = [
  { id: "t-wo", anchor: "map", kind: "rectangle", x: 10, y: 20, width: 30.1, height: 40.2, fillMode: "whiteout" },
  { id: "t-page", anchor: "page", kind: "text", x: 12, y: 280, text: "{event}", fontSizeMm: 5, color: "#000000" },
  { id: "t-toner", anchor: "map", kind: "path", points: [{ x: -50, y: -40 }, { x: 50, y: -40, hOut: { x: 2, y: 3 } }, { x: 50, y: 40 }], fillMode: "whiteoutInverted", closed: true },
  { id: "t-oob", anchor: "map", kind: "rectangle", x: 1, y: 2, width: 3, height: 4, fillMode: "outOfBounds" },
  purpleHatch,
  { id: "t-oob-solid", anchor: "map", kind: "rectangle", x: 5, y: 5, width: 2, height: 2, fillMode: "outOfBounds", stroke: "#000000", strokeWidthMm: 1 },
  { id: "t-708", anchor: "map", kind: "line", x1: 0, y1: 0, x2: 20, y2: 5, stroke: "#a626ff", strokeWidthMm: 0.7 },
  { id: "t-707", anchor: "map", kind: "line", x1: 1, y1: 1, x2: 21, y2: 6, stroke: "#A626FF", strokeWidthMm: 0.35, dash: "dashed" },
  { id: "t-closed-708", anchor: "map", kind: "path", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], fillMode: "none", closed: true, stroke: "#a626ff", strokeWidthMm: 0.35 },
  { id: "t-rect-707", anchor: "map", kind: "rectangle", x: 2, y: 3, width: 4, height: 5, fillMode: "none", stroke: "#a626ff", strokeWidthMm: 0.35, dash: "dashed" },
  { id: "t-text", anchor: "map", kind: "text", x: 8, y: 31, text: "{course}", fontSizeMm: 3, color: "#1f6fb2", fontFamily: "serif", align: "center", maxWidthMm: 50 },
  { id: "t-image", anchor: "map", kind: "image", graphicId: 7, x: 1, y: 2, width: 30, height: 10, crop: { x: 0.1, y: 0, width: 0.5, height: 1 } },
  { id: "t-legacy", anchor: "map", kind: "whiteoutRect", x: 0, y: 0, width: 1, height: 1 },
  { id: "t-invisible", anchor: "map", kind: "rectangle", x: 0, y: 0, width: 1, height: 1, fillMode: "none" },
  { id: "t-empty", anchor: "map", kind: "text", x: 0, y: 0, text: "", fontSizeMm: 3, color: "#000000" },
];
// What the template's objects become (map scale 15 000, print scale 10 000: os 1.5), in array order.
const templateBodies = [
  { kind: "whiteout", geometry: [{ x: 10, y: 20 }, { x: 10 + 30.1, y: 20 }, { x: 10 + 30.1, y: 20 + 40.2 }, { x: 10, y: 20 + 40.2 }], props: {} },
  { kind: "toner_saver", geometry: [{ x: -50, y: -40 }, { x: 50, y: -40, hOut: { x: 2, y: 3 } }, { x: 50, y: 40 }], props: {} },
  { kind: "oob_area", geometry: [{ x: 1, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 6 }, { x: 1, y: 6 }], props: {} },
  { kind: "oob_area", geometry: purpleHatch.points, props: { border: "dashed" } },
  { kind: "oob_area", geometry: [{ x: 5, y: 5 }, { x: 7, y: 5 }, { x: 7, y: 7 }, { x: 5, y: 7 }], props: { border: "solid" } },
  { kind: "oob_line", geometry: [{ x: 0, y: 0 }, { x: 20, y: 5 }], props: {} },
  { kind: "marked_route", geometry: [{ x: 1, y: 1 }, { x: 21, y: 6 }], props: {} },
  { kind: "oob_line", geometry: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 0 }], props: {} },
  { kind: "marked_route", geometry: [{ x: 2, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 8 }, { x: 2, y: 8 }, { x: 2, y: 3 }], props: {} },
  { kind: "text", geometry: [{ x: 8, y: 31 }], props: { text: "{course}", fontSizeMm: 2, color: "#1f6fb2", fontFamily: "serif", align: "center" } },
  { kind: "image", geometry: [{ x: 1, y: 2 }, { x: 31, y: 12 }], props: { graphicId: 7, crop: { x: 0.1, y: 0, width: 0.5, height: 1 } } },
  { kind: "whiteout", geometry: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], props: {} },
];

const square = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
const wo = (oid: string) => ({ id: oid, anchor: "map", kind: "path", points: square, fillMode: "whiteout", closed: true });
const page = (oid: string) => ({ id: oid, anchor: "page", kind: "rectangle", x: 1, y: 1, width: 2, height: 2, fillMode: "whiteout" });

const refusedSolid = { id: "s-solid", anchor: "map", kind: "rectangle", x: 0, y: 0, width: 4, height: 4, fillMode: "solid", fill: "#ff0000" };
const refusedBlack = { id: "t-black", anchor: "map", kind: "path", points: square, fillMode: "none", stroke: "#000000", strokeWidthMm: 0.35 };
const refusedStrokedWo = { id: "s-stroked-wo", anchor: "map", kind: "rectangle", x: 0, y: 0, width: 4, height: 4, fillMode: "whiteout", stroke: "#000000", strokeWidthMm: 0.35 };

const mapObjects = async (table: "map_templates" | "course_maps", rowId: string) =>
  (await one<{ objects: { id: string; anchor: string }[] }>(`SELECT objects FROM ${table} WHERE id = $1`, [rowId])).objects;
type ObjectRow = { seq: number; kind: string; geometry: unknown; props: unknown; scope: unknown; z: number; version: string; source: string | null };
const objectRows = async (eventId: string) =>
  (await db.query<ObjectRow>("SELECT seq, kind, geometry, props, scope, z, version::text, source FROM course_objects WHERE event_id = $1 ORDER BY seq", [eventId])).rows;

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${scratchName}"`);
  });
  db = new Client({ connectionString: scratchUrl.toString() });
  await db.connect();
  const before = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < F12)
    .map((d) => d.name)
    .sort();
  await db.query("SET search_path TO oxygen");
  for (const m of before) await db.query(readFileSync(resolve(MIGRATIONS, m, "migration.sql"), "utf8"));

  ids.live = await id("INSERT INTO events (name_id, name, date) VALUES ('f12_live', 'Live', '2026-11-08')");
  ids.nomap = await id("INSERT INTO events (name_id, name, date) VALUES ('f12_nomap', 'No map', '2026-11-08')");
  ids.removed = await id("INSERT INTO events (name_id, name, date, removed) VALUES ('f12_removed', 'Removed', '2026-11-08', true)");

  // The live event's base map at 1:15 000 (its latest map file's document); an older file at 1:4 000 is not read.
  const doc = async (hash: string, mapScale: number) => {
    await db.query("INSERT INTO map_sources (file_hash, kind, bytes, size_bytes, file_name) VALUES ($1, 'ocad', '\\x01', 1, 'm.ocd') ON CONFLICT DO NOTHING", ["a".repeat(64)]);
    await db.query(
      "INSERT INTO map_documents (hash, bytes, size_bytes, format_version, importer_version, library_version, source_hash, header, report) VALUES ($1, '\\x01', 1, 1, '1', '1', $2, $3, '{}')",
      [hash, "a".repeat(64), { mapScale }],
    );
  };
  await doc("b".repeat(64), 4000);
  await doc("c".repeat(64), 15000);
  await db.query("INSERT INTO map_files (event_id, file_name, document_hash, uploaded_at) VALUES ($1, 'old.ocd', $2, now() - interval '1 day')", [ids.live, "b".repeat(64)]);
  await db.query("INSERT INTO map_files (event_id, file_name, document_hash) VALUES ($1, 'new.ocd', $2)", [ids.live, "c".repeat(64)]);

  ids.course = await id("INSERT INTO courses (event_id, name) VALUES ($1, 'Blå')", [ids.live]);
  ids.cls = await id("INSERT INTO classes (event_id, name, course_id) VALUES ($1, 'H21', $2)", [ids.live, ids.course]);
  const settings = (purple: string) => ({ appearance: { purple, circleRadiusMm: 2.5, lineWidthMm: 0.35, numberHeightMm: 4 } });
  ids.template = await id("INSERT INTO map_templates (event_id, name, print_scale, settings, objects) VALUES ($1, 'A4', 10000, $2, $3)",
    [ids.live, settings("#a626ff"), JSON.stringify([...templateObjects, refusedBlack])]);
  ids.purpleTemplate = await id("INSERT INTO map_templates (event_id, name, print_scale, settings, objects) VALUES ($1, 'Own purple', 10000, $2, $3)",
    [ids.live, settings("#7F00FF"), JSON.stringify([{ id: "p-708", anchor: "map", kind: "line", x1: 0, y1: 0, x2: 1, y2: 1, stroke: "#7f00ff", strokeWidthMm: 0.35 }])]);

  const sheet = (fields: string, values: string, params: unknown[]) => id(`INSERT INTO course_maps (event_id, name, ${fields}) VALUES (${values})`, params);
  // Print scale 7 500 on the sheet: os 2.
  ids.courseSheet = await sheet("kind, course_id, template_id, overrides, objects", "$1, 'Blå karta', 'course', $2, $3, $4, $5",
    [ids.live, ids.course, ids.template, { printScale: 7500 }, JSON.stringify([page("s-page"), { id: "s-text", anchor: "map", kind: "text", x: 1, y: 2, text: "Hi", fontSizeMm: 4, color: "#000000" }, refusedSolid, refusedStrokedWo])]);
  ids.classSheet = await sheet("kind, course_id, class_id, template_id, objects", "$1, 'H21 karta', 'course', $2, $3, $4, $5",
    [ids.live, ids.course, ids.cls, ids.template, JSON.stringify([wo("c-wo")])]);
  ids.allSheet = await sheet("kind, template_id, objects", "$1, 'Alla', 'all_controls', $2, $3", [ids.live, ids.template, JSON.stringify([wo("a-wo")])]);
  ids.setterSheet = await sheet("kind, template_id, objects", "$1, 'Setter 1', 'setter', $2, $3", [ids.live, ids.template, JSON.stringify([wo("st-wo")])]);
  ids.setterCourseSheet = await sheet("kind, course_id, template_id, objects", "$1, 'Setter Blå', 'setter', $2, $3, $4", [ids.live, ids.course, ids.template, JSON.stringify([wo("sc-wo")])]);
  // No template: os 1 (resolveMapLayout's `(mapScale ?? printScale) / printScale` has no print scale to divide by).
  ids.bareSheet = await sheet("kind, objects", "$1, 'Bare', 'setter', $2", [ids.live, JSON.stringify([{ id: "b-text", anchor: "map", kind: "text", x: 0, y: 0, text: "T", fontSizeMm: 3, color: "#000000" }])]);

  // An event without a base map: os 1.
  const nomapTemplate = await id("INSERT INTO map_templates (event_id, name, print_scale) VALUES ($1, 'A4', 10000)", [ids.nomap]);
  ids.nomapSheet = await sheet("kind, template_id, objects", "$1, 'Alla', 'all_controls', $2, $3",
    [ids.nomap, nomapTemplate, JSON.stringify([{ id: "n-text", anchor: "map", kind: "text", x: 0, y: 0, text: "T", fontSizeMm: 3, color: "#000000" }])]);

  // A soft-deleted event: its refused object goes, its white-out moves.
  ids.removedSheet = await sheet("kind, objects", "$1, 'Alla', 'all_controls', $2", [ids.removed, JSON.stringify([refusedSolid, wo("r-wo"), page("r-page")])]);

  // A course object drawn by hand, already above z 0: the moved ones go under it.
  await db.query("INSERT INTO course_objects (event_id, kind, geometry, props, scope, z) VALUES ($1, 'whiteout', $2, '{}', '{\"all\": true}', 3)", [ids.live, JSON.stringify(square)]);

  await db.query("INSERT INTO club_map_templates (name, payload) VALUES ('Klubb', $1), ('Ren', $2)", [
    { name: "Klubb", printScale: 10000, objects: [wo("k-wo"), page("k-page")] },
    { name: "Ren", printScale: 10000, objects: [page("r-page")] },
  ]);
}, 180_000);

afterAll(async () => {
  await db?.end();
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`));
}, 60_000);

describe("F12 migration: map-anchored layout objects become course objects", () => {
  it("refuses a live event's object with no course-object kind, names each one and changes nothing", async () => {
    const err = await applyF12().then(() => null, (e: unknown) => e as Error & { detail?: string });
    expect(err?.message).toMatch(/^F12 guard: 3 map-anchored layout object\(s\) of live events have no course-object kind \(1 × coloured_stroke, 1 × solid_fill, 1 × stroked_whiteout\)/);
    expect(err?.detail?.split("\n")).toEqual([
      `event ${ids.live} map_templates seq 1 object t-black: coloured_stroke`,
      `event ${ids.live} course_maps seq 1 object s-solid: solid_fill`,
      `event ${ids.live} course_maps seq 1 object s-stroked-wo: stroked_whiteout`,
    ]);
    expect(await objectRows(ids.live)).toHaveLength(1);
    expect((await mapObjects("map_templates", ids.template)).map((o) => o.id)).toContain("t-wo");
    const check = await one<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'course_objects_source_check'");
    expect(check.def).not.toContain("layout");
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'f12_%'")).n).toBe("0");
  });

  it("moves every mappable object once the refused ones are fixed by hand (the runbook's fix-ups)", async () => {
    // Runbook fix-ups: drop the stroke of a stroked white-out; delete an object by id.
    await db.query(
      `UPDATE course_maps SET objects = (SELECT jsonb_agg(CASE WHEN e->>'id' = $2 THEN e - 'stroke' - 'strokeWidthMm' - 'dash' ELSE e END ORDER BY i)
         FROM jsonb_array_elements(objects) WITH ORDINALITY a(e, i)) WHERE event_id = $1 AND seq = 1`,
      [ids.live, "s-stroked-wo"],
    );
    for (const [table, oid] of [["map_templates", "t-black"], ["course_maps", "s-solid"]] as const) {
      await db.query(
        `UPDATE ${table} SET objects = (SELECT coalesce(jsonb_agg(e ORDER BY i), '[]') FROM jsonb_array_elements(objects) WITH ORDINALITY a(e, i) WHERE e->>'id' <> $2)
          WHERE event_id = $1 AND seq = 1`,
        [ids.live, oid],
      );
    }
    await applyF12();

    const rows = await objectRows(ids.live);
    const [handDrawn, ...moved] = rows;
    expect(handDrawn).toMatchObject({ kind: "whiteout", z: 3, source: null });
    const all = { all: true };
    const onCourse = { courses: [ids.course], classes: [] };
    const sheetWo = { kind: "whiteout", geometry: square, props: {} };
    // Templates (by seq), then sheets (by seq), each in array order; under the hand-drawn object; version 0; source 'layout'.
    expect(moved.map(({ kind, geometry, props, scope }) => ({ kind, geometry, props, scope }))).toEqual([
      ...templateBodies.map((b) => ({ ...b, scope: all })),
      { kind: "oob_line", geometry: [{ x: 0, y: 0 }, { x: 1, y: 1 }], props: {}, scope: all },
      { kind: "text", geometry: [{ x: 1, y: 2 }], props: { text: "Hi", fontSizeMm: 2, color: "#000000" }, scope: onCourse },
      { ...sheetWo, props: {}, geometry: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], scope: onCourse },
      { ...sheetWo, scope: { courses: [], classes: [ids.cls] } },
      { ...sheetWo, scope: all },
      { ...sheetWo, scope: all },
      { ...sheetWo, scope: onCourse },
      { kind: "text", geometry: [{ x: 0, y: 0 }], props: { text: "T", fontSizeMm: 3, color: "#000000" }, scope: all },
    ]);
    expect(new Set(moved.map((r) => [r.z, r.version, r.source].join()))).toEqual(new Set(["2,0,layout"]));
    expect(moved.map((r) => r.seq)).toEqual(moved.map((_, i) => handDrawn.seq + 1 + i));
    // Every body is one the API reads back (`storedObjectOf`'s schema).
    for (const r of moved) expect(course.courseObjectBodySchema.safeParse(r).success).toBe(true);

    // The rows keep their page-anchored objects, in order.
    expect(await mapObjects("map_templates", ids.template)).toEqual([templateObjects[1]]);
    expect(await mapObjects("map_templates", ids.purpleTemplate)).toEqual([]);
    expect(await mapObjects("course_maps", ids.courseSheet)).toEqual([page("s-page")]);
    for (const s of [ids.classSheet, ids.allSheet, ids.setterSheet, ids.setterCourseSheet, ids.bareSheet]) expect(await mapObjects("course_maps", s)).toEqual([]);

    // No base map: os 1.
    expect((await objectRows(ids.nomap)).map((r) => r.props)).toEqual([{ text: "T", fontSizeMm: 3, color: "#000000" }]);
    expect(await mapObjects("course_maps", ids.nomapSheet)).toEqual([]);

    // A soft-deleted event: the white-out moves, the refused object is gone, the page object stays.
    expect((await objectRows(ids.removed)).map((r) => r.kind)).toEqual(["whiteout"]);
    expect(await mapObjects("course_maps", ids.removedSheet)).toEqual([page("r-page")]);

    // Club templates: map-anchored objects stripped, page ones kept.
    const club = (await db.query<{ name: string; payload: { objects: unknown[] } }>("SELECT name, payload FROM club_map_templates ORDER BY name")).rows;
    expect(club.map((c) => [c.name, c.payload.objects])).toEqual([["Klubb", [page("k-page")]], ["Ren", [page("r-page")]]]);

    // 'layout' is a source; the helper functions are gone.
    const check = await one<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'course_objects_source_check'");
    expect(check.def).toContain("'layout'");
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'f12_%'")).n).toBe("0");
    expect((await one<{ n: string }>("SELECT count(*) AS n FROM course_maps WHERE objects @? '$[*] ? (@.anchor == \"map\")'")).n).toBe("0");
  });

  it("a second run changes nothing", async () => {
    const before = await db.query("SELECT id, seq, kind, geometry, props, scope, z, updated_at FROM course_objects ORDER BY id");
    const sheets = await db.query("SELECT id, objects, updated_at FROM course_maps ORDER BY id");
    await applyF12();
    expect((await db.query("SELECT id, seq, kind, geometry, props, scope, z, updated_at FROM course_objects ORDER BY id")).rows).toEqual(before.rows);
    expect((await db.query("SELECT id, objects, updated_at FROM course_maps ORDER BY id")).rows).toEqual(sheets.rows);
  });
});

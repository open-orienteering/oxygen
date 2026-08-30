/**
 * Integration tests for the course-editor API groundwork:
 *
 *   - control.create / control.update with map positions (xpos/ypos in
 *     paper mm) and WGS84 derivation via the uploaded map's CRS
 *   - IOF control descriptions stored on the control row
 *   - control.restore (undo of soft delete)
 *   - automatic course-geometry regeneration (geometrySource: "editor")
 *     when a control moves or a course's control sequence changes
 *
 * Uses the synthetic OCAD fixture `e2e/test.ocd` as the event map so the
 * CRS/scale-dependent paths (lat/lng derivation, length computation) run
 * for real.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import type { GeoJSONFeatureCollection } from "../../iof-course-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let mapScale: number;

beforeAll(async () => {
  ctx = await createTestEvent("control_editor");
  caller = makeCaller(ctx.event);

  const buf = readFileSync(FIXTURE);
  await caller.course.uploadMap({
    fileName: "test.ocd",
    fileDataBase64: buf.toString("base64"),
  });
  const meta = await caller.course.mapMetadata();
  expect(meta).not.toBeNull();
  mapScale = meta!.scale;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("control.create with position + description", () => {
  it("persists xpos/ypos, derives lat/lng from the map CRS, stores the description", async () => {
    const created = await caller.control.create({
      codes: "101",
      xpos: 50,
      ypos: -40,
      description: { d: "2.001", g: "11.143" },
    });
    expect(created.id).toBe(101);

    const row = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, codes: "101" },
    });
    expect(row?.xpos).toBe(50);
    expect(row?.ypos).toBe(-40);
    // The fixture is georeferenced — WGS84 must resolve to real values.
    expect(row?.lat).not.toBeNull();
    expect(row?.lng).not.toBeNull();
    expect(row?.lat).not.toBe(0);
    expect(row?.description).toEqual({ d: "2.001", g: "11.143" });

    const detail = await caller.control.detail({ id: 101 });
    expect(detail.description).toEqual({ d: "2.001", g: "11.143" });

    const coords = await caller.course.controlCoordinates();
    const c = coords.find((x) => x.id === 101);
    expect(c?.mapX).toBe(50);
    expect(c?.mapY).toBe(-40);
    expect(c?.description).toEqual({ d: "2.001", g: "11.143" });
  });

  it("rejects xpos without ypos", async () => {
    await expect(
      caller.control.create({ codes: "102", xpos: 10 }),
    ).rejects.toThrow(/xpos and ypos/i);
  });

  it("creates without position (unplaced) — lat/lng stay null", async () => {
    await caller.control.create({ codes: "103" });
    const row = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, codes: "103" },
    });
    expect(row?.xpos).toBe(0);
    expect(row?.lat).toBeNull();
  });
});

describe("control.update position / description", () => {
  it("moves a control and re-derives lat/lng", async () => {
    await caller.control.create({ codes: "111", xpos: 10, ypos: 10 });
    const before = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, codes: "111" },
    });
    await caller.control.update({ id: 111, xpos: 20, ypos: 30 });
    const after = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, codes: "111" },
    });
    expect(after?.xpos).toBe(20);
    expect(after?.ypos).toBe(30);
    expect(after?.lat).not.toBe(before?.lat);
  });

  it("updates and clears the description", async () => {
    await caller.control.create({ codes: "112" });
    await caller.control.update({ id: 112, description: { d: "1.009" } });
    let detail = await caller.control.detail({ id: 112 });
    expect(detail.description).toEqual({ d: "1.009" });

    await caller.control.update({ id: 112, description: null });
    detail = await caller.control.detail({ id: 112 });
    expect(detail.description).toBeNull();
  });
});

describe("course geometry regeneration", () => {
  it("course.create with controls generates straight-leg editor geometry + length", async () => {
    await caller.control.create({ codes: "121", xpos: 0, ypos: 10 });
    await caller.control.create({ codes: "122", xpos: 30, ypos: 50 }); // 50 mm leg
    const course = await caller.course.create({
      name: "EditorGeom-A",
      controlIds: [121, 122],
    });

    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(row?.geometrySource).toBe("editor");
    const geom = row?.geometry as unknown as GeoJSONFeatureCollection;
    const legs = geom.features.filter((f) => f.geometry.type === "LineString");
    const points = geom.features.filter((f) => f.geometry.type === "Point");
    expect(legs.length).toBeGreaterThanOrEqual(1);
    expect(points.length).toBeGreaterThanOrEqual(2);
    // 50 mm × scale / 1000 → meters for the 121→122 leg; total length must
    // be at least that.
    expect(row?.lengthM).toBeGreaterThanOrEqual(
      Math.round((50 * mapScale) / 1000),
    );
    expect(row?.legs).toMatch(/^\d+(;\d+)*;$/);
  });

  it("moving a control rebuilds the geometry of courses that use it", async () => {
    await caller.control.create({ codes: "131", xpos: 0, ypos: 0.1 });
    await caller.control.create({ codes: "132", xpos: 40, ypos: 0.1 });
    const course = await caller.course.create({
      name: "EditorGeom-B",
      controlIds: [131, 132],
    });
    const before = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
      select: { lengthM: true },
    });

    // Move 132 further away: 40 mm → 80 mm leg.
    await caller.control.update({ id: 132, xpos: 80, ypos: 0.1 });

    const after = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(after?.geometrySource).toBe("editor");
    expect(after!.lengthM).toBeGreaterThan(before!.lengthM);
    const geom = after?.geometry as unknown as GeoJSONFeatureCollection;
    const leg = geom.features.find(
      (f) =>
        f.geometry.type === "LineString" &&
        f.properties.from === "131" &&
        f.properties.to === "132",
    );
    expect(leg).toBeDefined();
    expect((leg!.geometry as { coordinates: number[][] }).coordinates[1][0]).toBe(80);
  });

  it("course.update with a new sequence rebuilds geometry", async () => {
    await caller.control.create({ codes: "141", xpos: 0, ypos: 20 });
    await caller.control.create({ codes: "142", xpos: 20, ypos: 20 });
    await caller.control.create({ codes: "143", xpos: 40, ypos: 20 });
    const course = await caller.course.create({
      name: "EditorGeom-C",
      controlIds: [141, 142],
    });

    await caller.course.update({ id: course.id, controlIds: [141, 142, 143] });

    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    const geom = row?.geometry as unknown as GeoJSONFeatureCollection;
    const codes = geom.features
      .filter((f) => f.geometry.type === "Point")
      .map((f) => f.properties.code);
    expect(codes).toContain("143");
    expect(row?.geometrySource).toBe("editor");
  });

  it("deleting a control cascades it out of course sequences and rebuilds geometry", async () => {
    await caller.control.create({ codes: "191", xpos: 0, ypos: 40 });
    await caller.control.create({ codes: "192", xpos: 30, ypos: 40 });
    await caller.control.create({ codes: "193", xpos: 60, ypos: 40 });
    const course = await caller.course.create({
      name: "EditorGeom-E",
      controlIds: [191, 192, 193],
    });

    await caller.control.delete({ id: 192 });

    // The sequence no longer references the deleted control…
    const detail = await caller.course.detail({ id: course.id });
    expect(detail.controls.split(";").filter(Boolean)).toEqual(["191", "193"]);
    // …the stored geometry was rebuilt without it (no ghost point, and
    // the leg now runs 191 → 193 directly)…
    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    const geom = row?.geometry as unknown as GeoJSONFeatureCollection;
    const pointCodes = geom.features
      .filter((f) => f.geometry.type === "Point")
      .map((f) => f.properties.code);
    expect(pointCodes).not.toContain("192");
    expect(
      geom.features.find(
        (f) =>
          f.geometry.type === "LineString" &&
          f.properties.from === "191" &&
          f.properties.to === "193",
      ),
    ).toBeDefined();
    // …and a follow-up sequence edit works (no 404 on a dead reference).
    await caller.course.update({ id: course.id, controlIds: [191] });
    const after = await caller.course.detail({ id: course.id });
    expect(after.controls.split(";").filter(Boolean)).toEqual(["191"]);
  });

  it("includes event start/finish controls in the rendered sequence", async () => {
    // Status 4 = start, 5 = finish (legacy integer codes at the boundary).
    await caller.control.create({ codes: "801", name: "Start 1", status: 4, xpos: 0, ypos: 100 });
    await caller.control.create({ codes: "802", name: "Mål 1", status: 5, xpos: 100, ypos: 100 });
    await caller.control.create({ codes: "151", xpos: 50, ypos: 100 });
    const course = await caller.course.create({
      name: "EditorGeom-D",
      controlIds: [151],
    });

    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    const geom = row?.geometry as unknown as GeoJSONFeatureCollection;
    const types = geom.features
      .filter((f) => f.geometry.type === "Point")
      .map((f) => f.properties.symbolType);
    expect(types).toContain("start");
    expect(types).toContain("finish");
    expect(types).toContain("control");
    // start → 151 → finish = two legs.
    expect(
      geom.features.filter((f) => f.geometry.type === "LineString"),
    ).toHaveLength(2);
  });
});

describe("course.clone", () => {
  it("copies course settings and sequence, then rebuilds geometry and length", async () => {
    const start = await caller.control.create({ status: 4, xpos: 0, ypos: 410 });
    const finish = await caller.control.create({ status: 5, xpos: 90, ypos: 410 });
    await caller.control.create({ codes: "201", xpos: 30, ypos: 410 });
    await caller.control.create({ codes: "202", xpos: 60, ypos: 410 });
    const source = await caller.course.create({
      name: "Clone source",
      controlIds: [201, 202],
      climb: 37,
      numberOfMaps: 4,
      firstAsStart: true,
    });
    await caller.course.update({
      id: source.id,
      startControlId: start.id,
      finishControlId: finish.id,
    });
    const sourceRow = await ctx.db.course.findFirstOrThrow({
      where: { eventId: ctx.eventId, seq: source.id },
    });
    await ctx.db.course.update({
      where: { id: sourceRow.id },
      data: { legs: "123;456;", shorten: 12 },
    });

    const cloned = await caller.course.clone({
      id: source.id,
      name: "  Clone copy  ",
    });

    expect(cloned.name).toBe("Clone copy");
    const detail = await caller.course.detail({ id: cloned.id });
    expect(detail.controls.split(";")).toEqual(["201", "202"]);
    expect(detail.startControlId).toBe(start.id);
    expect(detail.finishControlId).toBe(finish.id);
    expect(detail.firstAsStart).toBe(true);

    const cloneRow = await ctx.db.course.findFirstOrThrow({
      where: { eventId: ctx.eventId, seq: cloned.id },
    });
    expect(cloneRow.id).not.toBe(sourceRow.id);
    expect(cloneRow.climbM).toBe(37);
    expect(cloneRow.numberOfMaps).toBe(4);
    expect(cloneRow.startName).toBe(sourceRow.startName);
    expect(cloneRow.finishControlId).toBe(sourceRow.finishControlId);
    expect(cloneRow.shorten).toBe(12);
    expect(cloneRow.geometrySource).toBe("editor");
    expect(cloneRow.lengthM).toBeGreaterThan(0);

    const sourceAfter = await ctx.db.course.findUniqueOrThrow({
      where: { id: sourceRow.id },
    });
    expect(sourceAfter.name).toBe("Clone source");
    expect(sourceAfter.legs).toBe("123;456;");
  });

  it("rejects a duplicate active course name", async () => {
    const source = await caller.course.create({ name: "Clone conflict source" });
    await caller.course.create({ name: "Existing clone name" });
    await expect(
      caller.course.clone({ id: source.id, name: " Existing clone name " }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("start/finish placement from the editor", () => {
  /** Delete every active start/finish so auto-numbering is deterministic
   *  (earlier suites in this file create coded start/finish rows). */
  async function clearStartFinish() {
    const rows = await ctx.db.control.findMany({
      where: {
        eventId: ctx.eventId,
        status: { in: ["start", "finish"] },
        removed: false,
      },
      select: { seq: true, codes: true },
    });
    for (const r of rows) {
      const first = parseInt(r.codes.split(";")[0] ?? "", 10);
      await caller.control.delete({
        id: Number.isFinite(first) && first > 0 ? first : r.seq,
      });
    }
  }

  it("creates code-less start controls with sequential auto-names", async () => {
    await clearStartFinish();
    const s1 = await caller.control.create({ status: 4, xpos: 5, ypos: 5 });
    const s2 = await caller.control.create({ status: 4, xpos: 6, ypos: 6 });

    const rows = await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, status: "start", removed: false },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.name)).toEqual(["Start 1", "Start 2"]);
    expect(rows.every((r) => r.codes === "")).toBe(true);
    // Code-less controls are addressed by seq.
    expect(s1.id).toBe(rows[0].seq);
    expect(s2.id).toBe(rows[1].seq);
    // Position + WGS84 derivation work like for numbered controls.
    expect(rows[0].xpos).toBe(5);
    expect(rows[0].lat).not.toBeNull();

    const coords = await caller.course.controlCoordinates();
    const c1 = coords.find((c) => c.id === s1.id);
    expect(c1?.status).toBe(4);
    expect(c1?.code).toBe("Start 1");
  });

  it("creates a code-less finish control named Mål N", async () => {
    const f = await caller.control.create({ status: 5, xpos: 90, ypos: 5 });
    const row = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, status: "finish", removed: false },
    });
    expect(row?.name).toBe("Mål 1");
    expect(row?.codes).toBe("");
    expect(f.id).toBe(row?.seq);
  });

  it("still rejects a normal control without codes", async () => {
    await expect(
      caller.control.create({ status: 0, xpos: 1, ypos: 1 }),
    ).rejects.toThrow(/code/i);
  });

  it("creating a start/finish rebuilds editor-course geometry", async () => {
    await caller.control.create({ codes: "155", xpos: 50, ypos: 200 });
    await caller.control.create({ codes: "156", xpos: 80, ypos: 200 });
    const course = await caller.course.create({
      name: "EditorGeom-SF",
      controlIds: [155, 156],
    });
    // The event already has starts/finishes from earlier tests, so this
    // course's geometry starts out complete — the rebuild-on-create path
    // is what we're testing: add another start, then verify the course
    // geometry was regenerated in the same mutation (updatedAt & feature
    // count both move when the default start changes are re-derived).
    const before = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
      select: { geometry: true },
    });
    const beforeGeom = before?.geometry as unknown as GeoJSONFeatureCollection;
    expect(
      beforeGeom.features.some((f) => f.properties.symbolType === "start"),
    ).toBe(true);

    // Delete every start; geometry must lose the start leg…
    const starts = await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, status: "start", removed: false },
      select: { seq: true },
    });
    for (const s of starts) {
      await caller.control.delete({ id: s.seq });
    }
    const without = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
      select: { geometry: true },
    });
    const withoutGeom = without?.geometry as unknown as GeoJSONFeatureCollection;
    expect(
      withoutGeom.features.some((f) => f.properties.symbolType === "start"),
    ).toBe(false);

    // …and creating a new start must bring it back without any course edit.
    await caller.control.create({ status: 4, xpos: 20, ypos: 200 });
    const after = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
      select: { geometry: true },
    });
    const afterGeom = after?.geometry as unknown as GeoJSONFeatureCollection;
    expect(
      afterGeom.features.some((f) => f.properties.symbolType === "start"),
    ).toBe(true);
  });

  it("assigns a specific start and finish to a course", async () => {
    // Clean slate: drop starts left over from earlier tests so the
    // "default = lowest-seq start" assertions below are deterministic.
    const leftovers = await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, status: "start", removed: false },
      select: { seq: true },
    });
    for (const s of leftovers) {
      await caller.control.delete({ id: s.seq });
    }
    const sA = await caller.control.create({ status: 4, xpos: 0, ypos: 300 });
    const sB = await caller.control.create({ status: 4, xpos: 60, ypos: 300 });
    const fin = await caller.control.create({ status: 5, xpos: 90, ypos: 300 });
    await caller.control.create({ codes: "157", xpos: 30, ypos: 300 });
    const course = await caller.course.create({
      name: "EditorGeom-MultiStart",
      controlIds: [157],
    });

    await caller.course.update({
      id: course.id,
      startControlId: sB.id,
      finishControlId: fin.id,
    });

    const sBRow = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, seq: sB.id },
    });
    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(row?.startName).toBe(sBRow?.name);

    // Geometry must use the assigned start's position, not the default's.
    const geom = row?.geometry as unknown as GeoJSONFeatureCollection;
    const startPt = geom.features.find(
      (f) => f.properties.symbolType === "start",
    );
    expect(
      (startPt!.geometry as { coordinates: number[] }).coordinates[0],
    ).toBe(60);

    // course.list exposes the assignment for the editor UI.
    const summary = (await caller.course.list()).find(
      (c) => c.id === course.id,
    );
    expect(summary?.startControlId).toBe(sB.id);
    expect(summary?.finishControlId).toBe(fin.id);

    // Clearing goes back to the default (lowest-seq start = sA).
    await caller.course.update({
      id: course.id,
      startControlId: null,
      finishControlId: null,
    });
    const cleared = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(cleared?.startName).toBe("");
    expect(cleared?.finishControlId).toBeNull();
    const clearedGeom = cleared?.geometry as unknown as GeoJSONFeatureCollection;
    const clearedStart = clearedGeom.features.find(
      (f) => f.properties.symbolType === "start",
    );
    expect(
      (clearedStart!.geometry as { coordinates: number[] }).coordinates[0],
    ).toBe(0);
    void sA;
  });
});

describe("description backfill migration", () => {
  it("copies geometry-embedded descriptions onto matching control rows", async () => {
    // Legacy state: description only exists inside course geometry.
    await caller.control.create({ codes: "171" });
    await ctx.db.course.create({
      data: {
        eventId: ctx.eventId,
        name: "LegacyGeom",
        geometry: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [1, 2] },
              properties: {
                symbolType: "control",
                code: "171",
                description: { d: "4.004", c: "0.208" },
              },
            },
          ],
        },
        geometrySource: "ocd",
      },
    });

    // Run the migration's backfill UPDATE verbatim (everything from the
    // first UPDATE keyword onward) so this test guards the actual SQL.
    const migrationSql = readFileSync(
      resolve(
        __dirname,
        "../../../prisma/migrations/20260817000000_control_description/migration.sql",
      ),
      "utf8",
    );
    const backfill = migrationSql.slice(migrationSql.indexOf("UPDATE"));
    await ctx.db.$executeRawUnsafe(backfill);

    const detail = await caller.control.detail({ id: 171 });
    expect(detail.description).toEqual({ d: "4.004", c: "0.208" });
  });
});

describe("control.restore", () => {
  it("restores a soft-deleted control", async () => {
    await caller.control.create({ codes: "161", name: "Boulder" });
    await caller.control.delete({ id: 161 });
    let list = await caller.control.list();
    expect(list.find((c) => c.id === 161)).toBeUndefined();

    const restored = await caller.control.restore({ id: 161 });
    expect(restored.id).toBe(161);
    list = await caller.control.list();
    expect(list.find((c) => c.id === 161)?.name).toBe("Boulder");
  });

  it("refuses to restore when the code has been reused", async () => {
    await caller.control.create({ codes: "162" });
    await caller.control.delete({ id: 162 });
    await caller.control.create({ codes: "162" });
    await expect(caller.control.restore({ id: 162 })).rejects.toThrow(
      /already exists/i,
    );
  });

  it("404s for a control that was never deleted", async () => {
    await expect(caller.control.restore({ id: 9999 })).rejects.toThrow(
      /not found/i,
    );
  });

  it("restoring a start rebuilds editor-course geometry (undo of delete)", async () => {
    // Isolate: no other start may absorb the implicit-start role.
    const priorStarts = await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, status: "start", removed: false },
      select: { seq: true, codes: true },
    });
    for (const r of priorStarts) {
      const first = parseInt(r.codes.split(";")[0] ?? "", 10);
      await caller.control.delete({
        id: Number.isFinite(first) && first > 0 ? first : r.seq,
      });
    }

    const start = await caller.control.create({ status: 4, xpos: 10, ypos: 300 });
    await caller.control.create({ codes: "165", xpos: 40, ypos: 300 });
    const course = await caller.course.create({
      name: "RestoreGeom",
      controlIds: [165],
    });
    const readGeom = async () => {
      const row = await ctx.db.course.findFirst({
        where: { eventId: ctx.eventId, seq: course.id },
        select: { geometry: true },
      });
      return row?.geometry as unknown as GeoJSONFeatureCollection;
    };
    expect(
      (await readGeom()).features.some(
        (f) => f.properties.symbolType === "start",
      ),
    ).toBe(true);

    // Delete drops the start leg from the geometry…
    await caller.control.delete({ id: start.id });
    expect(
      (await readGeom()).features.some(
        (f) => f.properties.symbolType === "start",
      ),
    ).toBe(false);

    // …and restore (the editor's undo) must put it back.
    await caller.control.restore({ id: start.id });
    expect(
      (await readGeom()).features.some(
        (f) => f.properties.symbolType === "start",
      ),
    ).toBe(true);
  });
});

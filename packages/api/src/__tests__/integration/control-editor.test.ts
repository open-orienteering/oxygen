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
});

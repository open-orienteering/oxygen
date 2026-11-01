/**
 * The structure backfill (slice D, row D1; docs/course-layer.md §6.4):
 * a course with a NULL structure gets the one its columns describe, an
 * `ocd` row also the cuts, leg gaps and course objects its stored GeoJSON
 * carries; per course in a transaction, a second run changes nothing, and
 * the report compares regenerated with stored geometry.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { planStructureBackfill, runStructureBackfill } from "../../course-structure-backfill.js";

let ctx: TestEventContext;
let other: TestEventContext;
const ids: Record<string, string> = {};

const line = (symbolType: string, coordinates: number[][], extra: Record<string, unknown> = {}) => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { symbolType, ...extra } });
const point = (symbolType: string, code: string, xy: number[], extra: Record<string, unknown> = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: xy }, properties: { symbolType, code, id: code, ...extra } });

const OCD_GEOMETRY = {
  type: "FeatureCollection",
  features: [
    point("start", "STA1", [10, 0]),
    point("control", "71", [20, 0], { cuts: [{ start: 10, end: 40 }] }),
    point("control", "72", [120, 0]),
    point("finish", "FIN1", [130, 0]),
    line("leg", [[10, 0], [20, 0]], { from: "STA1", to: "71" }),
    line("leg", [[25, 0], [60, 0]], { from: "71", to: "72", preclipped: true }),
    line("leg", [[80, 0], [115, 0]], { from: "71", to: "72", preclipped: true }),
    line("leg", [[120, 0], [130, 0]], { from: "72", to: "FIN1" }),
    line("marked_route", [[1, 1], [2, 2]]),
    line("restricted_line", [[3, 3], [4, 4]]),
  ],
};

async function seedCourse(c: TestEventContext, name: string, geometry: unknown, source: string) {
  const mk = (n: string, codes: string, status: string, x: number, y: number) =>
    c.db.control.create({ data: { eventId: c.eventId, name: n, codes, status, xpos: x, ypos: y }, select: { id: true } });
  const s = await mk(`Start ${name}`, "", "start", 10, 0);
  const a = await mk("", `71${name}`, "ok", 20, 0);
  const b = await mk("", `72${name}`, "ok", 120, 0);
  const f = await mk(`Mål ${name}`, "", "finish", 130, 0);
  const course = await c.db.course.create({
    data: { eventId: c.eventId, name, startName: `Start ${name}`, finishControlId: f.id, geometry: geometry as never, geometrySource: source },
    select: { id: true },
  });
  await c.db.courseControl.createMany({ data: [{ courseId: course.id, position: 1, controlId: a.id }, { courseId: course.id, position: 2, controlId: b.id }] });
  ids[name] = course.id;
  ids[`${name}:a`] = a.id;
  return course.id;
}

beforeAll(async () => {
  ctx = await createTestEvent("structure_backfill");
  other = await createTestEvent("structure_backfill_other");
  await seedCourse(ctx, "Ocd1", OCD_GEOMETRY, "ocd");
  await seedCourse(ctx, "Ocd2", OCD_GEOMETRY, "ocd");
  await seedCourse(ctx, "Editor", { type: "FeatureCollection", features: [] }, "editor");
  await seedCourse(other, "Elsewhere", null, "");
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await other?.cleanup();
  await disconnect();
}, 30_000);

describe("planStructureBackfill", () => {
  it("lists courses with a NULL structure, optionally of one event", async () => {
    expect((await planStructureBackfill(ctx.db, { eventId: ctx.eventId })).map((i) => i.name).sort()).toEqual(["Editor", "Ocd1", "Ocd2"]);
    const all = await planStructureBackfill(ctx.db);
    expect(all.map((i) => i.name)).toContain("Elsewhere");
    expect((await planStructureBackfill(ctx.db, { eventId: other.eventId })).map((i) => i.name)).toEqual(["Elsewhere"]);
  });
});

describe("runStructureBackfill", () => {
  it("fills the event's courses: columns → structure, ocd rows also cuts, gaps and objects, with the comparison", async () => {
    const run = await runStructureBackfill(ctx.db, { eventId: ctx.eventId });
    expect(run).toMatchObject({ total: 3, filled: 3, skipped: 0, failed: 0 });

    const ocd1 = await ctx.db.course.findUniqueOrThrow({ where: { id: ids.Ocd1 } });
    const items = (ocd1.structure as { items: { siteId: string; leg?: { gaps: unknown[] } }[] }).items;
    expect(items).toHaveLength(4); // start, 71, 72, finish
    expect(items[2].leg).toEqual({ gaps: [{ from: 0.4, to: 0.6 }] });
    // The flat columns are untouched by the backfill.
    expect(ocd1.startName).toBe("Start Ocd1");
    expect(ocd1.finishControlId).not.toBeNull();
    expect(await ctx.db.courseControl.count({ where: { courseId: ids.Ocd1 } })).toBe(2);

    const ctl = await ctx.db.control.findUniqueOrThrow({ where: { id: ids["Ocd1:a"] } });
    expect(ctl.circleGaps).toEqual([{ start: 10, end: 40 }]);

    const editor = await ctx.db.course.findUniqueOrThrow({ where: { id: ids.Editor } });
    expect(editor.structure).not.toBeNull();

    const r1 = run.results.find((r) => r.name === "Ocd1")!;
    expect(r1).toMatchObject({ outcome: "filled", items: 4, circleGapControls: 1, legGaps: 1 });
    expect(r1.comparison).toMatchObject({ bboxDeltaMm: 0, positionDeltaMm: 0 });
    expect(r1.comparison!.legs).toEqual({ pieces: 1, withGaps: 1 });
  });

  it("objects are written once per event: the 708 line shared, the 707 scoped to both courses", async () => {
    const objs = await ctx.db.courseObject.findMany({ where: { eventId: ctx.eventId }, orderBy: { seq: "asc" } });
    expect(objs.map((o) => [o.kind, o.source])).toEqual([["marked_route", "import"], ["oob_line", "import"]]);
    expect(objs[0].scope).toEqual({ courses: expect.arrayContaining([ids.Ocd1, ids.Ocd2]), classes: [] });
    expect(objs[1].scope).toEqual({ all: true });
  });

  it("is idempotent: a second run has nothing to do and changes nothing", async () => {
    const before = await ctx.db.course.findMany({ where: { eventId: ctx.eventId }, select: { id: true, structure: true, updatedAt: true }, orderBy: { id: "asc" } });
    const run = await runStructureBackfill(ctx.db, { eventId: ctx.eventId });
    expect(run).toMatchObject({ total: 0, filled: 0 });
    const after = await ctx.db.course.findMany({ where: { eventId: ctx.eventId }, select: { id: true, structure: true, updatedAt: true }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
    expect(await ctx.db.courseObject.count({ where: { eventId: ctx.eventId } })).toBe(2);
  });

  it("another event's course stays pending after an event-scoped run; a dry run plans only", async () => {
    expect((await planStructureBackfill(ctx.db, { eventId: other.eventId })).length).toBe(1);
    const dry = await runStructureBackfill(ctx.db, { eventId: other.eventId, dryRun: true });
    expect(dry).toMatchObject({ total: 1, filled: 0 });
    expect((await planStructureBackfill(ctx.db, { eventId: other.eventId })).length).toBe(1);
  });
});

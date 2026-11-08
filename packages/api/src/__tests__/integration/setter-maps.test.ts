/**
 * Setter maps and the all-controls sheet's recalculation
 * (docs/course-layout.md §6, §8; research 08 §4.6; slice F, row F10):
 * `layout.setterMaps`, `layout.moveToSetter`, `layout.recalculateSheet`,
 * a setter sheet through `resolveSheet` / `courseMap.list`, and
 * `maps.pdf?setter=1`.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STANDARD_PRINT_SCALES, setterSheetPropsSchema } from "@oxygen/shared";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { applyEventMap } from "../../event-map.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import { sheetInputForMapRow } from "../../course-maps/pdf-page.js";
import { resolveSheet } from "../../course-maps/resolve-sheet.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  registerCourseMapRoutes(server);
  await server.ready();
});

afterAll(async () => {
  await server.close();
  await disconnect();
});

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected a rejection");
}

describe("setter maps (course-layout.md §8, F10)", () => {
  let t: TestEventContext;
  let caller: ReturnType<typeof makeCaller>;
  const c: Record<string, { id: string; seq: number }> = {};
  let course: { id: string; seq: number };
  const pdfUrl = (q: string) => `/api/maps/${t.nameId}/maps.pdf${q}`;
  const setterRows = (courseId: string | null = null) =>
    t.db.courseMap.findMany({ where: { eventId: t.eventId, kind: "setter", courseId }, include: { template: true }, orderBy: { sortOrder: "asc" } });
  const groupOf = (row: { props: unknown }) => setterSheetPropsSchema.parse(row.props).controlIds;

  beforeAll(async () => {
    t = await createTestEvent("setter_maps");
    caller = makeCaller(t.event);
    const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`setter-${randomBytes(4).toString("hex")}`)]);
    await applyEventMap(t.db, t.eventId, "test.ocd", bytes);
    clearEventDocumentCaches();
    const mk = async (key: string, codes: string, xpos: number, ypos: number, kind = "control") => {
      c[key] = await t.db.control.create({ data: { eventId: t.eventId, codes, xpos, ypos, kind } });
    };
    // West: 31, 32, 33 and a map-issue point; east: 41, 42, 43. An unplaced 50 is never grouped.
    await mk("c33", "33", -50, -5);
    await mk("c31", "31", -60, 0);
    await mk("c32", "32", -55, 10);
    await mk("issue", "", -52, 3, "map_issue");
    await mk("c41", "41", 50, 0);
    await mk("c42", "42", 55, 8);
    await mk("c43", "43", 60, -4);
    await mk("c50", "50", 0, 0);
    course = await t.db.course.create({
      data: { eventId: t.eventId, name: "Blå", lengthM: 3000, climbM: 20, courseControls: { create: [c.c31, c.c32, c.c41].map((x, i) => ({ position: i + 1, controlId: x.id })) } },
    });
    await caller.layout.autoSheets({ courseId: course.seq });
  }, 90_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  it("the migration accepts a setter row with and without a course", async () => {
    const template = (await t.db.mapTemplate.findFirstOrThrow({ where: { eventId: t.eventId } })).id;
    const a = await t.db.courseMap.create({ data: { eventId: t.eventId, kind: "setter", name: "raw", templateId: template } });
    const b = await t.db.courseMap.create({ data: { eventId: t.eventId, kind: "setter", name: "raw", courseId: course.id, templateId: template } });
    await t.db.courseMap.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    // The other kinds keep their rule.
    await expect(t.db.courseMap.create({ data: { eventId: t.eventId, kind: "all_controls", name: "x", courseId: course.id } })).rejects.toThrow();
  });

  it("groups the event's placed sites into n deterministic sheets on fitted A4 templates; 5 mm cells, centred", async () => {
    const r = await caller.layout.setterMaps({ groups: 2 });
    const rows = await setterRows();
    expect(rows.map((s) => [s.name, s.courseId, s.windowCenter, setterSheetPropsSchema.parse(s.props).setter])).toEqual([
      ["Setter 1", null, null, 1],
      ["Setter 2", null, null, 2],
    ]);
    // West first; the map-issue point is the west setter's; the unplaced control is no one's.
    expect(new Set(groupOf(rows[0]))).toEqual(new Set([c.c31.id, c.c32.id, c.c33.id, c.issue.id]));
    expect(new Set(groupOf(rows[1]))).toEqual(new Set([c.c41.id, c.c42.id, c.c43.id]));
    expect(r.sheets.map((s) => s.setter)).toEqual([1, 2]);
    expect(r.sheets[1].controls.sort()).toEqual([41, 42, 43].sort());
    for (const row of rows) {
      expect(row.template?.paper).toBe("A4");
      expect(STANDARD_PRINT_SCALES as readonly number[]).toContain(row.template?.printScale);
      expect(row.overrides).toEqual({ description: { cellSizeMm: 5 } });
    }
    // Setter sheets come after the event's other course-less sheets.
    const courseSheet = await t.db.courseMap.findFirstOrThrow({ where: { eventId: t.eventId, kind: "course" } });
    expect(courseSheet.templateId).not.toBeNull();

    // Regenerate: the same groups on new rows; the old ones are gone.
    const again = await caller.layout.setterMaps({ groups: 2 });
    const rows2 = await setterRows();
    expect(rows2.map((s) => s.seq)).toEqual(again.sheets.map((s) => s.seq));
    expect(rows2.map((s) => s.seq).some((seq) => rows.some((o) => o.seq === seq))).toBe(false);
    expect(rows2.map((s) => new Set(groupOf(s)))).toEqual(rows.map((s) => new Set(groupOf(s))));
  });

  it("refuses more groups than placed sites, and a course outside the event", async () => {
    expect((await errorOf(caller.layout.setterMaps({ groups: 8 }))).code).toBe("BAD_REQUEST");
    expect((await errorOf(caller.layout.setterMaps({ groups: 0 }))).code).toBe("BAD_REQUEST");
    expect((await errorOf(caller.layout.setterMaps({ courseId: 99999, groups: 1 }))).code).toBe("NOT_FOUND");
    expect(await setterRows()).toHaveLength(2);
  });

  it("a course's setter maps hold its sites and the map-issue points, and leave the event's alone", async () => {
    const r = await caller.layout.setterMaps({ courseId: course.seq, groups: 1 });
    const rows = await setterRows(course.id);
    expect(rows.map((s) => s.name)).toEqual(["Blå · Setter 1"]);
    expect(new Set(groupOf(rows[0]))).toEqual(new Set([c.c31.id, c.c32.id, c.c41.id, c.issue.id]));
    expect(r.sheets[0].controls).toHaveLength(4);
    expect(await setterRows()).toHaveLength(2);
    await t.db.courseMap.deleteMany({ where: { id: rows[0].id } });
  });

  it("resolveSheet of a setter sheet: its group only, codes, setter marks with 702, the block in code order at 5 mm", async () => {
    const [west] = await setterRows();
    const sheet = await caller.courseMap.resolveSheet({ seq: west.seq });
    expect(sheet.sheet?.kind).toBe("setter");
    expect(sheet.sheet?.setter).toEqual({ index: 1, controls: expect.any(Array) });
    expect(sheet.labelMode).toBe("code");
    expect(sheet.block.header).toBeNull();
    expect(sheet.block.title).toBe("Setter 1");
    expect(sheet.block.rows.map((r) => r.code)).toEqual(["31", "32", "33"]);
    expect(sheet.page.description?.cellSizeMm).toBe(5);
    expect(sheet.controls.map((x) => x.id).sort()).toEqual([c.c31.id, c.c32.id, c.c33.id, c.issue.id].sort());
    // Its own window only: no sibling windows.
    expect(sheet.windows).toHaveLength(1);
    // The window is centred on the group: x between −60 and −50.
    expect(sheet.window.minX + sheet.window.width / 2).toBeCloseTo(-55, 3);

    // The print path's view options: a setter view, the map-issue site drawn as 702.
    const row = await t.db.courseMap.findUniqueOrThrow({ where: { id: west.id }, include: { template: true, course: { include: { classes: { select: { name: true } }, courseControls: { orderBy: { position: "asc" }, include: { control: true } } } } } });
    const allControls = (await t.db.control.findMany({ where: { eventId: t.eventId, removed: false } })).map((x) => ({ ...x, name: x.name ?? "" }));
    const resolved = resolveSheet(sheetInputForMapRow(row, { event: { name: "E", date: new Date(0) }, allControls, mapInfo: { scale: 10000, meridianTiltDeg: null } }));
    expect(resolved.sheet.course.viewOptions).toMatchObject({ allControls: true, setterMarks: true, labelMode: "code" });
    expect(resolved.sheet.course.structure).toBeNull();
    expect(resolved.sheet.course.sites.map((s) => s.kind).sort()).toEqual(["control", "control", "control", "map_issue"]);
    expect(resolved.sheet.description?.cellSizeMm).toBe(5);

    // courseMap.list: the setter part, public control ids in code order (a code-less point by its seq).
    const listed = (await caller.courseMap.list()).find((m) => m.seq === west.seq)!;
    expect(listed.setter?.index).toBe(1);
    expect(listed.setter?.controls.filter((s) => s !== c.issue.seq)).toEqual([31, 32, 33]);
    expect(listed.setter?.controls).toContain(c.issue.seq);
    expect((await caller.courseMap.list()).filter((m) => m.kind === "course").every((m) => m.setter === null)).toBe(true);
  });

  it("moveToSetter moves a control between two setter sheets of a scope; windows stay; undo moves it back", async () => {
    const [west, east] = await setterRows();
    const r = await caller.layout.moveToSetter({ controlId: 33, sheet: east.seq });
    expect(r.from).toBe(west.seq);
    expect(r.to).toBe(east.seq);
    const [w2, e2] = await setterRows();
    expect(groupOf(w2)).not.toContain(c.c33.id);
    expect(groupOf(e2)).toContain(c.c33.id);
    expect(w2.version).toBeGreaterThan(west.version);
    expect(e2.version).toBeGreaterThan(east.version);
    expect(r.sheets).toEqual([{ seq: west.seq, version: w2.version.toString() }, { seq: east.seq, version: e2.version.toString() }]);
    expect([w2.windowCenter, e2.windowCenter, w2.templateId, e2.templateId]).toEqual([null, null, west.templateId, east.templateId]);
    // The same sheet: nothing written.
    const same = await caller.layout.moveToSetter({ controlId: 33, sheet: east.seq });
    expect(same.sheets).toEqual([{ seq: east.seq, version: e2.version.toString() }]);
    // Back.
    await caller.layout.moveToSetter({ controlId: 33, sheet: west.seq });
    expect(groupOf((await setterRows())[0])).toContain(c.c33.id);
    // A control in no setter map, and a sheet that is not a setter's.
    expect((await errorOf(caller.layout.moveToSetter({ controlId: 50, sheet: east.seq }))).code).toBe("BAD_REQUEST");
    const courseSheet = await t.db.courseMap.findFirstOrThrow({ where: { eventId: t.eventId, kind: "course" } });
    expect((await errorOf(caller.layout.moveToSetter({ controlId: 33, sheet: courseSheet.seq }))).code).toBe("NOT_FOUND");
  });

  it("recalculateSheet refits the all-controls sheet: a standard scale, centred, no scale override, the block on the template's spot", async () => {
    const a = await caller.layout.autoSheets({ allControls: true });
    const seq = a.allControlsSheet!;
    const before = await t.db.courseMap.findFirstOrThrow({ where: { eventId: t.eventId, seq }, include: { template: true } });
    await caller.courseMap.saveLayout({
      id: seq,
      windowCenter: { x: 30, y: 30 },
      printScale: 12345,
      description: { visible: true, x: 20, y: 20, cellSizeMm: 7 },
      objects: [],
    });
    const r = await caller.layout.recalculateSheet({ sheet: seq });
    const after = await t.db.courseMap.findFirstOrThrow({ where: { eventId: t.eventId, seq }, include: { template: true } });
    expect(after.windowCenter).toBeNull();
    expect(after.overrides).toEqual({ description: { visible: true, cellSizeMm: 7 } });
    expect(after.template?.paper).toBe(before.template?.paper);
    expect(STANDARD_PRINT_SCALES as readonly number[]).toContain(after.template?.printScale);
    expect(r).toMatchObject({ seq, version: after.version.toString(), templateSeq: after.template?.seq });
    const listed = (await caller.courseMap.list()).find((m) => m.seq === seq)!;
    expect(listed.template?.autoKey).toBe(`${after.template!.paper}-${after.template!.orientation}-${after.template!.printScale}`);
  });

  it("recalculateSheet refits a setter sheet to its group; a course sheet is refused", async () => {
    const [west] = await setterRows();
    await t.db.courseMap.update({ where: { id: west.id }, data: { windowCenter: { x: 1, y: 1 } } });
    await caller.layout.recalculateSheet({ sheet: west.seq });
    const after = (await setterRows())[0];
    expect(after.windowCenter).toBeNull();
    expect(after.template?.paper).toBe("A4");
    expect(after.overrides).toEqual({ description: { cellSizeMm: 5 } });
    const courseSheet = await t.db.courseMap.findFirstOrThrow({ where: { eventId: t.eventId, kind: "course" } });
    expect((await errorOf(caller.layout.recalculateSheet({ sheet: courseSheet.seq }))).code).toBe("BAD_REQUEST");
  });

  it("maps.pdf?setter=1 prints every setter sheet; courses and the unfiltered export leave them out", async () => {
    clearEventDocumentCaches();
    const res = await server.inject({ method: "GET", url: pdfUrl("?setter=1") });
    expect(res.statusCode).toBe(200);
    expect((await PDFDocument.load(res.rawPayload)).getPageCount()).toBe(2);
    const courses = await server.inject({ method: "GET", url: pdfUrl(`?courses=${course.seq}`) });
    expect((await PDFDocument.load(courses.rawPayload)).getPageCount()).toBe(1);
    // The course sheet and the all-controls sheet.
    const all = await server.inject({ method: "GET", url: pdfUrl("") });
    expect((await PDFDocument.load(all.rawPayload)).getPageCount()).toBe(2);
    expect((await server.inject({ method: "GET", url: pdfUrl(`?setter=1&courses=${course.seq}`) })).statusCode).toBe(400);
  }, 90_000);

  it("maps.pdf?setter=1 without setter maps says so", async () => {
    await t.db.courseMap.deleteMany({ where: { eventId: t.eventId, kind: "setter" } });
    const res = await server.inject({ method: "GET", url: pdfUrl("?setter=1") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No setter maps/);
  });
});

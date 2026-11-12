/**
 * Crossing points, map-issue points and map exchanges on the API (slice F,
 * row F4; docs/course-layer.md §6.3, §10.3):
 *
 *   - control.create / update write all six kinds; crossing and map-issue
 *     points are code-less, an exchange takes codes; status sync unchanged
 *   - course.setStructure refuses a crossing / map-issue item
 *     (SITE_KIND_NOT_ITEM) and a leg crossing naming another kind
 *     (CROSSING_KIND); an exchange item and a leg through a crossing pass
 *   - the crossing rides the wire as a public id, course.list carries it,
 *     the length follows it; controlCoordinates carries the kind
 *   - a kind change that would break a stored structure is refused;
 *     control.delete of a crossing strips the legs naming it, restore +
 *     setStructure(before) undoes it
 *   - print: a course sheet draws the crossing it runs through and derives
 *     the 13.3 row; only the all-controls sheet has setter marks
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { resolveSheet } from "../../course-maps/resolve-sheet.js";
import { sheetInputForMapRow, type PrintMapRow } from "../../course-maps/pdf-page.js";
import { editorCourseLayer, legDistancesMm, loadCourseSequences } from "../../course-geometry.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let startSeq: number;
let finishSeq: number;
let crossing: number;

beforeAll(async () => {
  ctx = await createTestEvent("course_crossings");
  caller = makeCaller(ctx.event);
  startSeq = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
  finishSeq = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
  for (const [code, x] of [[31, 30], [32, 50], [33, 70]] as const) {
    await caller.control.create({ codes: String(code), xpos: x, ypos: 10 });
  }
  crossing = (await caller.control.create({ kind: "crossing_point", xpos: 40, ypos: 20 })).id;
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

const rowOf = (publicId: number) =>
  ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, removed: false, OR: [{ codes: String(publicId) }, { seq: publicId, codes: "" }] } });
const courseRow = (seq: number) => ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
const through = (via: number, section?: boolean) => ({
  version: 1 as const,
  id: "x",
  orderMode: "ordered" as const,
  items: [{ siteId: startSeq }, { siteId: 31 }, { siteId: 32, leg: { crossing: { controlId: via, ...(section ? { section } : {}) } } }, { siteId: finishSeq }],
});

describe("kinds on control.create / update (§6.3)", () => {
  it("creates code-less crossing and map-issue points named like starts; their public id is the seq", async () => {
    const p = await rowOf(crossing);
    expect([p.kind, p.status, p.codes, p.name]).toEqual(["crossing_point", "ok", "", "Passeringspunkt 1"]);
    expect(p.seq).toBe(crossing);
    // Its seq is above every punch code (MARK_SEQ_BASE), so its public id never names a control.
    expect(crossing).toBeGreaterThan(10_000);
    const m = await caller.control.create({ kind: "map_issue", xpos: 60, ypos: 30 });
    const mr = await rowOf(m.id);
    expect([mr.kind, mr.status, mr.name]).toEqual(["map_issue", "ok", "Kartutdelning 1"]);
    const list = await caller.control.list();
    expect(list.find((c) => c.id === crossing)).toMatchObject({ kind: "crossing_point", status: 0 });
    await caller.control.delete({ id: m.id });
  });

  it("an exchange takes codes like a control", async () => {
    await expect(caller.control.create({ kind: "map_exchange", xpos: 1, ypos: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const x = await caller.control.create({ kind: "map_exchange", codes: "80", xpos: 60, ypos: 10 });
    expect(x.id).toBe(80);
    expect((await rowOf(80)).kind).toBe("map_exchange");
  });

  it("status sync is unchanged: a start turned crossing point leaves status 4", async () => {
    const s = await caller.control.create({ status: 4, xpos: 5, ypos: 5 });
    await caller.control.update({ id: s.id, kind: "crossing_point" });
    const row = await rowOf(s.id); // its code since F32
    expect([row.kind, row.status]).toEqual(["crossing_point", "ok"]);
    await caller.control.delete({ id: s.id });
  });

  it("controlCoordinates carries the kind", async () => {
    const coords = await caller.course.controlCoordinates();
    expect(coords.find((c) => c.id === crossing)?.kind).toBe("crossing_point");
    expect(coords.find((c) => c.id === 80)?.kind).toBe("map_exchange");
    expect(coords.find((c) => c.id === startSeq)?.kind).toBe("start");
  });
});

describe("course.setStructure and the slice-F kinds (§6.1)", () => {
  it("refuses a crossing point as an item and a leg crossing naming a control", async () => {
    const { id } = await caller.course.create({ name: "Refused" });
    const was = (await courseRow(id)).structure;
    const asItem = { version: 1 as const, id: "x", orderMode: "ordered" as const, items: [{ siteId: startSeq }, { siteId: crossing }, { siteId: finishSeq }] };
    await expect(caller.course.setStructure({ courseId: id, structure: asItem })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("SITE_KIND_NOT_ITEM") });
    await expect(caller.course.setStructure({ courseId: id, structure: through(33) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("CROSSING_KIND") });
    await expect(caller.course.setStructure({ courseId: id, structure: through(9999) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await courseRow(id)).structure).toEqual(was);
  });

  it("accepts an exchange item and a leg through a crossing point; the wire, the list and the length carry it", async () => {
    const { id } = await caller.course.create({ name: "Crossing" });
    const straight = await caller.course.create({ name: "Straight", controlIds: [31, 32] });
    await caller.course.setStructure({ courseId: id, structure: through(crossing, true) });
    const row = await courseRow(id);
    const items = (row.structure as { items: { leg?: { crossing?: { controlId: string } } }[] }).items;
    expect(items[2].leg!.crossing!.controlId).toBe((await rowOf(crossing)).id);
    // course_controls are the items only.
    const ccs = await ctx.db.courseControl.findMany({ where: { courseId: row.id }, orderBy: { position: "asc" }, include: { control: true } });
    expect(ccs.map((cc) => cc.control.codes)).toEqual(["31", "32"]);

    const detail = await caller.course.detail({ id });
    const leg = detail.structure.items[2] as { leg?: { crossing?: { controlId: number; section?: boolean } } };
    expect(leg.leg!.crossing).toEqual({ controlId: crossing, section: true });
    const listed = (await caller.course.list()).find((c) => c.id === id)!;
    expect(listed.legs).toEqual({ "31>32": { crossing: { controlId: String(crossing), section: true } } });
    // The lengths' sequence runs the leg through the crossing point (31 (30,10) → P (40,20) → 32 (50,10)).
    const seq = (await loadCourseSequences(ctx.db, ctx.eventId, [row.id])).get(row.id)!.seq;
    expect(seq[2].via).toEqual({ id: (await rowOf(crossing)).id, xMm: 40, yMm: 20 });
    expect(legDistancesMm(editorCourseLayer(row.id, seq))[1]).toBeCloseTo(2 * Math.hypot(10, 10), 6);

    const withExchange = { ...through(crossing), items: [{ siteId: startSeq }, { siteId: 31 }, { siteId: 80 }, { siteId: 32 }, { siteId: finishSeq }] };
    await caller.course.setStructure({ courseId: straight.id, structure: withExchange });
    expect((await ctx.db.courseControl.count({ where: { courseId: (await courseRow(straight.id)).id } }))).toBe(3);
  });

  it("a kind change that would break a stored structure is refused, nothing written", async () => {
    await expect(caller.control.update({ id: crossing, kind: "control" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("CROSSING_KIND") });
    expect((await rowOf(crossing)).kind).toBe("crossing_point");
    await expect(caller.control.update({ id: 31, kind: "map_issue" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("SITE_KIND_NOT_ITEM") });
    expect((await rowOf(31)).kind).toBe("control");
    // A control in a variation's alternative cannot become an exchange (VARIATION_CROSSES_EXCHANGE).
    const g = await caller.course.create({ name: "Grouped" });
    await caller.course.setStructure({
      courseId: g.id,
      structure: {
        version: 1, id: "g", orderMode: "ordered",
        items: [{ siteId: startSeq }, { siteId: 31 }, { kind: "variation", id: "v", alternatives: [{ label: "A", items: [{ siteId: 33 }] }, { label: "B", items: [] }] }, { siteId: 32 }, { siteId: finishSeq }],
      },
    });
    await expect(caller.control.update({ id: 33, kind: "map_exchange" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("VARIATION_CROSSES_EXCHANGE") });
    expect((await rowOf(33)).kind).toBe("control");
    await caller.course.delete({ id: g.id });
    // Unused sites change freely.
    const free = await caller.control.create({ codes: "77", xpos: 3, ypos: 3 });
    await caller.control.update({ id: free.id, kind: "map_exchange" });
    expect((await rowOf(77)).kind).toBe("map_exchange");
  });

  it("moving the crossing point rebuilds the courses running through it (a course.upserted each)", async () => {
    const c = await courseRow((await caller.course.list()).find((x) => x.name === "Crossing")!.id);
    const count = () => ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "course.upserted", payload: { path: ["id"], equals: c.id } } });
    const before = await count();
    await caller.control.update({ id: crossing, xpos: 40, ypos: 40 });
    expect(await count()).toBe(before + 1);
    await caller.control.update({ id: crossing, xpos: 40, ypos: 20 });
  });

  it("control.delete strips the legs through the crossing (token advanced, journaled); restore + setStructure(before) undoes it", async () => {
    const c = (await caller.course.list()).find((x) => x.name === "Crossing")!;
    const before = await caller.course.detail({ id: c.id });
    const res = await caller.control.delete({ id: crossing });
    expect(res.courses.map((x) => x.id)).toContain(c.id);
    const row = await courseRow(c.id);
    const items = (row.structure as { items: { leg?: unknown }[] }).items;
    expect(items[2]).not.toHaveProperty("leg");
    const entry = await ctx.db.journalEntry.findFirstOrThrow({ where: { eventId: ctx.eventId, type: "course.upserted", hlc: row.version } });
    expect((entry.payload as { fields: { structure: unknown } }).fields.structure).toEqual(row.structure);

    await caller.control.restore({ id: crossing });
    await caller.course.setStructure({ courseId: c.id, structure: before.structure! });
    const again = await caller.course.detail({ id: c.id });
    expect((again.structure.items[2] as { leg?: unknown }).leg).toEqual({ crossing: { controlId: crossing, section: true } });
  });
});

describe("print (course-print.md §5.2; course-layer.md §10.3)", () => {
  it("a course sheet draws the crossing its leg runs through and derives 13.4; only the all-controls sheet has setter marks", async () => {
    await caller.control.create({ kind: "map_issue", xpos: 60, ypos: 30 });
    const c = (await caller.course.list()).find((x) => x.name === "Crossing")!;
    const courseUuid = (await courseRow(c.id)).id;
    const template = await ctx.db.mapTemplate.create({
      data: {
        eventId: ctx.eventId,
        name: "A4 crossings",
        printScale: 10000,
        settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance },
        objects: [],
      },
    });
    await ctx.db.courseMap.create({ data: { eventId: ctx.eventId, name: "Crossing sheet", kind: "course", courseId: courseUuid, templateId: template.id } });
    await ctx.db.courseMap.create({ data: { eventId: ctx.eventId, name: "All", kind: "all_controls", templateId: template.id, sortOrder: 1 } });
    const rows = (await ctx.db.courseMap.findMany({
      where: { eventId: ctx.eventId },
      include: { template: true, course: { include: { classes: { select: { name: true } }, courseControls: { orderBy: { position: "asc" }, include: { control: true } } } } },
      orderBy: [{ sortOrder: "asc" }],
    })) as unknown as PrintMapRow[];
    const allControls = await ctx.db.control.findMany({ where: { eventId: ctx.eventId, removed: false } });
    const base = { event: { name: "E", date: new Date() }, allControls, mapInfo: { scale: 10000, meridianTiltDeg: 0 } };
    const p = (await rowOf(crossing)).id;

    const own = resolveSheet(sheetInputForMapRow(rows.find((r) => r.kind === "course")!, base));
    expect(own.sheet.course.sites.find((s) => s.id === p)?.kind).toBe("crossing_point");
    expect(own.sheet.course.sites.some((s) => s.kind === "map_issue")).toBe(false);
    expect(own.sheet.course.viewOptions.setterMarks).toBeUndefined();
    const st = own.sheet.course.structure as { items: { leg?: { crossing?: { controlId: string } } }[] };
    expect(st.items.some((i) => i.leg?.crossing?.controlId === p)).toBe(true);
    // 31 → P → 32: the 13.4 row after 31.
    const rowKeys = own.layout.descriptionRows.map((r) => (r.kind === "special" ? r.symbolKey : r.kind === "control" ? r.code : r.kind));
    expect(rowKeys).toEqual(["start", "31", "13.4", "32", "finish"]);

    const all = resolveSheet(sheetInputForMapRow(rows.find((r) => r.kind === "all_controls")!, base));
    expect(all.sheet.course.viewOptions.setterMarks).toBe(true);
    expect(all.sheet.course.sites.find((s) => s.id === p)?.kind).toBe("crossing_point");
    expect(all.sheet.course.sites.some((s) => s.kind === "map_issue")).toBe(true);
    // The block lists controls only.
    expect(all.layout.descriptionRows.map((r) => r.code)).not.toContain(String(crossing));
  });
});

/**
 * Integration tests for automatic overprint cuts: circle slits and leg
 * gaps the course layer computes around the pinned map document's
 * features, for the event's stored courses (docs/course-layer.md §3.4,
 * §4.3). Nothing stores them since E5 dropped `courses.geometry`: the GL
 * layer and the print compute them at draw time, as `drawnCuts` does here
 * from the same inputs (the course's sequence, the document's cut
 * features, the event's toggle).
 *
 * Uses the synthetic OCAD fixture's known features in the otherwise
 * empty top-right corner (see `scripts/generate-test-ocd.mjs`): a boulder
 * (ISOM 204) at 68/42 mm and a building (ISOM 521) spanning
 * 48–58 / 39–46 mm.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { uploadEventMap } from "../helpers/upload-map.js";
import { applyEventMap } from "../../event-map.js";
import { loadEventCutFeatures } from "../../event-map-objects.js";
import { legacySizeContext, loadCourseSequences } from "../../course-geometry.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { loadPinnedPrintDocument, pageInputFor, sheetForMapRow, type PrintMapRow } from "../../course-maps/pdf-page.js";
import { loadBundledFonts } from "../../render/fonts.js";
import { composePage } from "@oxygen/shared/print";
import { course as courseShared, defaultMapAppearance } from "@oxygen/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("overprint_cuts");
  caller = makeCaller(ctx.event);
  const buf = readFileSync(FIXTURE);
  await uploadEventMap(caller, ctx.nameId, buf);
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

const KIND = { Start: "start", Control: "control", Finish: "finish" } as const;

/**
 * The automatic cuts the course layer draws for a stored course: its
 * sequence, the pinned document's cut features, none when the event's
 * toggle is off. `circle(code)` is a control's slits, `leg(from, to)` a
 * leg's gaps.
 */
async function drawnCuts(db: PrismaClient, eventId: bigint, courseSeq: number) {
  const row = await db.course.findFirstOrThrow({ where: { eventId, seq: courseSeq }, select: { id: true } });
  const { seq, orderMode } = (await loadCourseSequences(db, eventId, [row.id])).get(row.id)!;
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { autoOverprintCuts: true } });
  const cutFeatures = event.autoOverprintCuts ? await loadEventCutFeatures(db, eventId) : null;
  const layer = courseShared.courseLayer({
    structure: { version: 1, id: row.id, orderMode, items: seq.map((c) => ({ siteId: c.id, role: KIND[c.type] })) },
    sites: seq.map((c) => ({ id: c.id, code: c.code, kind: KIND[c.type], x: c.xMm, y: c.yMm })),
    objects: [],
    appearance: {},
    viewOptions: {},
    document: legacySizeContext(),
    ...(cutFeatures ? { cutFeatures } : {}),
  });
  const idOf = new Map(seq.map((c) => [c.code, c.id]));
  const { sites, courses } = layer.derivation;
  return {
    circle: (code: string) => sites.find((s) => s.id === idOf.get(code))?.cuts ?? [],
    leg: (from: string, to: string) => courses[0]?.legs.find((l) => l.from === idOf.get(from) && l.to === idOf.get(to))?.gaps ?? [],
  };
}

const cutsOf = (courseSeq: number) => drawnCuts(ctx.db, ctx.eventId, courseSeq);

describe("automatic overprint cuts of the event's courses", () => {
  it("slits a control circle whose rim passes over the boulder", async () => {
    // 2.5 mm south of the boulder: the boulder sits due north on the rim.
    await caller.control.create({ codes: "161", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "162", xpos: 90, ypos: 60 }); // empty area
    const course = await caller.course.create({
      name: "Cuts-A",
      controlIds: [161, 162],
    });

    const drawn = await cutsOf(course.id);
    const cuts = drawn.circle("161");
    expect(cuts).toHaveLength(1);
    // Slit spans compass north (start just below 360, end just above 0).
    expect(cuts[0].start).toBeGreaterThan(300);
    expect(cuts[0].end).toBeLessThan(60);
    expect(drawn.circle("162")).toEqual([]);
  });

  it("does not gap a leg crossing a building", async () => {
    await caller.control.create({ codes: "163", xpos: 44, ypos: 42 });
    await caller.control.create({ codes: "164", xpos: 64, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-B",
      controlIds: [163, 164],
    });

    expect((await cutsOf(course.id)).leg("163", "164")).toEqual([]);
  });

  it("gaps a leg crossing the boulder", async () => {
    await caller.control.create({ codes: "167", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "168", xpos: 76, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-Boulder-Leg",
      controlIds: [167, 168],
    });

    const gaps = (await cutsOf(course.id)).leg("167", "168");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
  });

  it("recomputes cuts when a control moves", async () => {
    await caller.control.create({ codes: "165", xpos: 90, ypos: 30 });
    await caller.control.create({ codes: "166", xpos: 90, ypos: 55 });
    const course = await caller.course.create({
      name: "Cuts-C",
      controlIds: [165, 166],
    });

    expect((await cutsOf(course.id)).circle("165")).toEqual([]);

    // Move 165 onto the boulder rim.
    await caller.control.update({ id: 165, xpos: 68, ypos: 39.5 });
    expect((await cutsOf(course.id)).circle("165")).toHaveLength(1);

    // And away again: cuts disappear.
    await caller.control.update({ id: 165, xpos: 90, ypos: 30 });
    expect((await cutsOf(course.id)).circle("165")).toEqual([]);
  });

  it("a course created before the map is cut once the upload pins the document", async () => {
    const other = await createTestEvent("overprint_cuts_upload");
    try {
      const otherCaller = makeCaller(other.event);
      await otherCaller.control.create({ codes: "171", xpos: 68, ypos: 39.5 });
      await otherCaller.control.create({ codes: "172", xpos: 90, ypos: 60 });
      const course = await otherCaller.course.create({
        name: "Cuts-D",
        controlIds: [171, 172],
      });

      // No map yet → no cuts.
      expect((await drawnCuts(other.db, other.eventId, course.id)).circle("171")).toEqual([]);

      const buf = readFileSync(FIXTURE);
      await uploadEventMap(otherCaller, other.nameId, buf);

      expect((await drawnCuts(other.db, other.eventId, course.id)).circle("171")).toHaveLength(1);
    } finally {
      await other.cleanup();
    }
  });

  it("setOverprintCuts(false) strips cuts/gaps; true restores them; the toggle writes the flag only", async () => {
    await caller.control.create({ codes: "181", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "182", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "183", xpos: 76, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-Toggle",
      controlIds: [181, 182, 183],
    });

    let drawn = await cutsOf(course.id);
    expect(drawn.circle("181")).toHaveLength(1);
    expect(drawn.leg("182", "183")).toHaveLength(1);
    const before = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: course.id } });
    const journalBefore = await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } });

    const off = await caller.course.setOverprintCuts({ enabled: false });
    expect(off.enabled).toBe(false);
    expect((await caller.course.getOverprintCuts()).enabled).toBe(false);
    // Kiosk-readable: every map view's GL course layer follows the toggle (course-layer.md §3.4).
    const key = `k-cuts-${randomBytes(4).toString("hex")}`;
    await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: key } });
    try {
      const kiosk = makeCaller({ ...ctx.event, kioskKey: key }, { user: null, authEnabled: true, authMode: "proxy", kioskKey: key });
      expect((await kiosk.course.getOverprintCuts()).enabled).toBe(false);
      await expect(kiosk.course.setOverprintCuts({ enabled: true })).rejects.toThrow();
    } finally {
      await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: null } });
    }

    drawn = await cutsOf(course.id);
    expect(drawn.circle("181")).toEqual([]);
    expect(drawn.leg("182", "183")).toEqual([]);
    // Nothing stored depends on the flag (E5): the course row and the journal are untouched.
    expect(await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: course.id } })).toEqual(before);
    expect(await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } })).toBe(journalBefore);

    const on = await caller.course.setOverprintCuts({ enabled: true });
    expect(on.enabled).toBe(true);
    drawn = await cutsOf(course.id);
    expect(drawn.circle("181")).toHaveLength(1);
    expect(drawn.leg("182", "183")).toHaveLength(1);
  });
});

describe("events cut against their pinned document", () => {
  let vec: TestEventContext;
  let vecCaller: ReturnType<typeof makeCaller>;
  let documentHash: string;
  let uploadCourseSeq: number;

  beforeAll(async () => {
    vec = await createTestEvent("overprint_cuts_vector");
    vecCaller = makeCaller(vec.event);
    // A course on the boulder before any map: cut once the upload below pins.
    await vecCaller.control.create({ codes: "191", xpos: 68, ypos: 39.5 });
    await vecCaller.control.create({ codes: "192", xpos: 90, ypos: 60 });
    uploadCourseSeq = (await vecCaller.course.create({ name: "Vec-Upload", controlIds: [191, 192] })).id;
    // Per-run trailer: content-addressed rows are global (see map-documents.test.ts).
    const bytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`cuts-${randomBytes(4).toString("hex")}`)]);
    const applied = await applyEventMap(vec.db, vec.eventId, "test.ocd", bytes);
    expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
    documentHash = applied.documentHash!;
  }, 60_000);

  afterAll(async () => {
    await vec?.cleanup();
  });

  const vecCuts = (seq: number) => drawnCuts(vec.db, vec.eventId, seq);

  it("reads the same features for two events pinning the same map", async () => {
    const fromVector = await loadEventCutFeatures(vec.db, vec.eventId);
    const fromLegacy = await loadEventCutFeatures(ctx.db, ctx.eventId);
    const key = (f: { x: number; y: number }) => `${f.x.toFixed(3)},${f.y.toFixed(3)}`;
    expect(fromVector!.map(key).sort()).toEqual(fromLegacy!.map(key).sort());
    const boulder = (fs: Array<{ x: number; y: number; r?: number }>) => fs.find((f) => Math.abs(f.x - 68) < 1e-3 && Math.abs(f.y - 42) < 1e-3);
    expect(boulder(fromVector!)?.r).toBeCloseTo(boulder(fromLegacy!)!.r!, 6);
  });

  it("cuts the course created before the map", async () => {
    expect((await vecCuts(uploadCourseSeq)).circle("191")).toHaveLength(1);
  });

  it("cuts a circle and a leg as the other event does, within rounding", async () => {
    await vecCaller.control.create({ codes: "193", xpos: 68, ypos: 39.5 });
    await vecCaller.control.create({ codes: "194", xpos: 60, ypos: 42 });
    await vecCaller.control.create({ codes: "195", xpos: 76, ypos: 42 });
    const vecCourse = await vecCaller.course.create({ name: "Vec-Cuts", controlIds: [193, 194, 195] });
    await caller.control.create({ codes: "196", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "197", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "198", xpos: 76, ypos: 42 });
    const legacyCourse = await caller.course.create({ name: "Legacy-Cuts", controlIds: [196, 197, 198] });

    const v = await vecCuts(vecCourse.id);
    const l = await cutsOf(legacyCourse.id);
    const vCuts = v.circle("193");
    const lCuts = l.circle("196");
    expect(vCuts).toHaveLength(1);
    expect(vCuts[0].start).toBeCloseTo(lCuts[0].start, 6);
    expect(vCuts[0].end).toBeCloseTo(lCuts[0].end, 6);
    const vGaps = v.leg("194", "195");
    const lGaps = l.leg("197", "198");
    expect(vGaps).toHaveLength(1);
    expect(vGaps[0].from).toBeCloseTo(lGaps[0].from, 6);
    expect(vGaps[0].to).toBeCloseTo(lGaps[0].to, 6);
  });

  it("the event's auto cuts off reach the vector print: no automatic slits or gaps, a stored circle gap still drawn (course-layer.md §3.4)", async () => {
    const db = vec.db;
    const mk = (codes: string, xpos: number, ypos: number) => db.control.create({ data: { eventId: vec.eventId, codes, xpos, ypos } });
    const onRim = await mk("291", 68, 39.5); // the boulder on its rim
    const a = await mk("292", 60, 42);
    const b = await mk("293", 76, 42); // leg a–b crosses the boulder
    const template = await db.mapTemplate.create({
      data: {
        eventId: vec.eventId,
        name: "Cuts A4",
        printScale: 15000,
        settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance },
        objects: [],
      },
    });
    const crs = await db.course.create({
      data: { eventId: vec.eventId, name: "Vec-Print", courseControls: { create: [{ position: 1, controlId: onRim.id }, { position: 2, controlId: a.id }, { position: 3, controlId: b.id }] } },
    });
    await db.courseMap.create({ data: { eventId: vec.eventId, name: "Vec-Print", kind: "course", courseId: crs.id, templateId: template.id, windowCenter: { x: 68, y: 42 } } });
    const loadRow = async () => (await db.courseMap.findFirstOrThrow({
      where: { eventId: vec.eventId, courseId: crs.id },
      include: { template: true, course: { include: { classes: { select: { name: true } }, courseControls: { orderBy: { position: "asc" }, include: { control: true } } } } },
    })) as unknown as PrintMapRow;
    const pinned = (await loadPinnedPrintDocument(db, vec.eventId))!;
    const fonts = await loadBundledFonts();
    const stream = async (opts: { features?: boolean } = {}) => {
      const event = await db.event.findUniqueOrThrow({ where: { id: vec.eventId } });
      const allControls = await db.control.findMany({ where: { eventId: vec.eventId, removed: false } });
      const sheet = sheetForMapRow(await loadRow(), { event: { name: event.name, date: event.date }, allControls, mapInfo: pinned.info, autoCuts: event.autoOverprintCuts });
      const doc = opts.features === false ? { ...pinned.document, cutFeatures: [] } : pinned.document;
      return { sheet, stream: composePage(pageInputFor(doc, sheet, null), fonts).mapLayer.stream };
    };
    try {
      const on = await stream();
      expect("autoCuts" in on.sheet.course.viewOptions).toBe(false);
      expect(on.stream).not.toEqual((await stream({ features: false })).stream);

      await vecCaller.course.setOverprintCuts({ enabled: false });
      const off = await stream();
      expect(off.sheet.course.viewOptions.autoCuts).toBe(false);
      expect(off.stream).not.toEqual(on.stream);
      // Off = exactly the page without any cut features: no automatic slit on 291, no gap on 292–293.
      expect(off.stream).toEqual((await stream({ features: false })).stream);

      // A stored circle gap is the setter's choice: it still draws with the toggle off.
      await db.control.update({ where: { id: a.id }, data: { circleGaps: [{ start: 80, end: 100 }] } });
      const manual = await stream();
      expect(manual.sheet.course.sites.find((x) => x.id === a.id)?.circleGaps).toEqual([{ start: 80, end: 100 }]);
      expect(manual.stream).not.toEqual(off.stream);
    } finally {
      await vecCaller.course.setOverprintCuts({ enabled: true });
      await db.courseMap.deleteMany({ where: { eventId: vec.eventId, courseId: crs.id } });
      await db.course.delete({ where: { id: crs.id } });
      await db.mapTemplate.delete({ where: { id: template.id } });
      await db.control.deleteMany({ where: { id: { in: [onRim.id, a.id, b.id] } } });
    }
  }, 60_000);

  it("cuts nothing while no document is pinned — no OCAD fallback", async () => {
    await vec.db.mapFile.updateMany({ where: { eventId: vec.eventId }, data: { documentHash: null } });
    try {
      expect(await loadEventCutFeatures(vec.db, vec.eventId)).toBeNull();
      expect((await vecCuts(uploadCourseSeq)).circle("191")).toEqual([]);
    } finally {
      await vec.db.mapFile.updateMany({ where: { eventId: vec.eventId }, data: { documentHash } });
    }
  });
});

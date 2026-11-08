/**
 * Integration test for the IOF CourseData export.
 *
 * Seeds an event with a map (so the CRS/scale paths run), start/finish
 * controls, two courses and a class assignment, then round-trips the
 * exported XML back through the importer's parser and asserts the model
 * survived.
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
import { uploadEventMap } from "../helpers/upload-map.js";
import {
  buildEventCourseDataXml,
  buildEventPpenXml,
  buildCourseExportFilename,
} from "../../course-export.js";
import { parseIOFCourseData } from "../../iof-course-parser.js";
import { parsePpenCourseData } from "../../ppen-course-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let mapScale: number;

beforeAll(async () => {
  ctx = await createTestEvent("course_export");
  caller = makeCaller(ctx.event);

  const buf = readFileSync(FIXTURE);
  await uploadEventMap(caller, ctx.nameId, buf);
  const meta = await caller.course.mapMetadata();
  mapScale = meta!.scale;

  // Event start/finish (legacy integer status codes at the boundary).
  await caller.control.create({ codes: "901", name: "Start", status: 4, xpos: 0, ypos: 0.5 });
  await caller.control.create({ codes: "902", name: "Mål", status: 5, xpos: 100, ypos: 0.5 });
  await caller.control.create({ codes: "31", xpos: 20, ypos: 0.5 });
  await caller.control.create({ codes: "32", xpos: 60, ypos: 0.5 });
  // Never placed: must not reach the XML.
  await caller.control.create({ codes: "33" });

  const a = await caller.course.create({ name: "Export A", controlIds: [31, 32] });
  await caller.course.create({ name: "Export B", controlIds: [32] });

  const cls = await caller.class.create({ name: "H21 Export" });
  await caller.class.update({ id: cls.id, courseId: a.id });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("buildEventCourseDataXml", () => {
  it("exports controls, courses and class assignments that round-trip", async () => {
    const xml = await buildEventCourseDataXml(ctx.db, {
      id: ctx.eventId,
      name: ctx.event.name,
    });
    const parsed = parseIOFCourseData(xml);

    expect(parsed.mapScale).toBe(mapScale);

    // Placed controls only, with the event start/finish typed as such.
    const ids = parsed.controls.map((c) => c.id);
    expect(ids).toContain("31");
    expect(ids).toContain("32");
    expect(ids).not.toContain("33");
    expect(parsed.controls.find((c) => c.id === "901")!.type).toBe("Start");
    expect(parsed.controls.find((c) => c.id === "902")!.type).toBe("Finish");
    // The fixture is georeferenced, so real WGS84 coordinates come along.
    const c31 = parsed.controls.find((c) => c.id === "31")!;
    expect(c31.mapX).toBe(20);
    expect(c31.lat).not.toBe(0);

    // Course sequences carry the event start/finish rows around the
    // course's own controls, mirroring the rendered geometry.
    const courseA = parsed.courses.find((c) => c.name === "Export A")!;
    expect(courseA.controls.map((cc) => cc.controlId)).toEqual([
      "901", "31", "32", "902",
    ]);
    expect(courseA.controls.map((cc) => cc.type)).toEqual([
      "Start", "Control", "Control", "Finish",
    ]);
    expect(courseA.length).toBeGreaterThan(0);
    // Legs come from the stored per-leg meters (3 legs for 4 rows).
    expect(courseA.controls.slice(1).every((cc) => cc.legLength > 0)).toBe(true);

    const courseB = parsed.courses.find((c) => c.name === "Export B")!;
    expect(courseB.controls.map((cc) => cc.controlId)).toEqual(["901", "32", "902"]);

    expect(parsed.classAssignments).toEqual([
      { className: "H21 Export", courseName: "Export A" },
    ]);
  });

  it("derives editor-course lengths and legs from current coordinates at export time", async () => {
    const course = await ctx.db.course.findFirstOrThrow({
      where: { eventId: ctx.eventId, name: "Export A" },
      select: { id: true },
    });
    // Simulate stale derived fields left by an old import/build. The export
    // must not trust them for an edited course (`length_source = 'derived'`;
    // `geometry_source` is no longer read, E6).
    await ctx.db.course.update({
      where: { id: course.id },
      data: { lengthM: 1, legs: "1;1;1;", lengthSource: "derived" },
    });

    const parsed = parseIOFCourseData(
      await buildEventCourseDataXml(ctx.db, {
        id: ctx.eventId,
        name: ctx.event.name,
      }),
    );
    const exported = parsed.courses.find((c) => c.name === "Export A")!;
    // 0.5→20.5→60.5→100.5 mm: 100 mm × map scale / 1000.
    expect(exported.length).toBe(Math.round((100 * mapScale) / 1000));
    expect(exported.controls.slice(1).map((cc) => cc.legLength)).toEqual([
      Math.round((20 * mapScale) / 1000),
      Math.round((40 * mapScale) / 1000),
      Math.round((40 * mapScale) / 1000),
    ]);
  });

  it("exports the published length of a 'file' or NULL length_source course (E6)", async () => {
    const course = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, name: "Export A" }, select: { id: true } });
    try {
      for (const lengthSource of ["file", null] as const) {
        await ctx.db.course.update({ where: { id: course.id }, data: { lengthM: 4321, lengthSource } });
        const parsed = parseIOFCourseData(await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name }));
        expect(parsed.courses.find((c) => c.name === "Export A")!.length).toBe(4321);
      }
      // No published length: the derived one.
      await ctx.db.course.update({ where: { id: course.id }, data: { lengthM: 0, lengthSource: null } });
      const parsed = parseIOFCourseData(await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name }));
      expect(parsed.courses.find((c) => c.name === "Export A")!.length).toBe(Math.round((100 * mapScale) / 1000));
    } finally {
      await ctx.db.course.update({ where: { id: course.id }, data: { lengthSource: "derived" } });
    }
  });

  it("emits randomOrder on free-order courses and round-trips orderMode", async () => {
    const created = await caller.course.create({
      name: "Export Free",
      controlIds: [31, 32],
      orderMode: "free_order",
    });
    const xml = await buildEventCourseDataXml(ctx.db, {
      id: ctx.eventId,
      name: ctx.event.name,
    });
    expect(xml).toMatch(
      /CourseControl[^>]*type="Control"[^>]*\brandomOrder="true"/,
    );
    // Free-order Control rows omit LegLength.
    expect(xml).not.toMatch(
      /<Name>Export Free<\/Name>[\s\S]*?type="Control"[^>]*>[\s\S]*?<LegLength/,
    );

    const parsed = parseIOFCourseData(xml);
    const free = parsed.courses.find((c) => c.name === "Export Free");
    expect(free?.orderMode).toBe("free_order");
    expect(
      free?.controls
        .filter((c) => c.type === "Control")
        .every((c) => c.randomOrder),
    ).toBe(true);

    await caller.course.delete({ id: created.id });
  });

  it("builds a safe attachment filename", () => {
    expect(buildCourseExportFilename("itest")).toBe("itest-courses.xml");
    expect(buildCourseExportFilename("a b/c")).toBe("a_b_c-courses.xml");
    expect(buildCourseExportFilename("itest", "ppen")).toBe("itest-courses.ppen");
  });
});

describe("buildEventPpenXml", () => {
  it("exports a Purple Pen document that round-trips through the parser", async () => {
    const xml = await buildEventPpenXml(ctx.db, {
      id: ctx.eventId,
      name: ctx.event.name,
    });
    expect(xml).toContain("<course-scribe-event>");
    expect(xml).toContain(">test.ocd</map>");

    const parsed = parsePpenCourseData(xml);
    expect(parsed.mapScale).toBe(mapScale);
    expect(parsed.controls.some((c) => c.id === "31")).toBe(true);
    expect(parsed.controls.some((c) => c.id === "32")).toBe(true);
    expect(parsed.controls.some((c) => c.id === "33")).toBe(false);

    const courseA = parsed.courses.find((c) => c.name === "Export A")!;
    expect(courseA.controls.map((cc) => cc.type)).toEqual([
      "Start",
      "Control",
      "Control",
      "Finish",
    ]);
    expect(courseA.controls.map((cc) => cc.controlId).slice(1, 3)).toEqual([
      "31",
      "32",
    ]);
  });
});

/** The stored per-leg metres of a course row. */
const storedLegs = (legs: string | null) => (legs ?? "").split(";").filter(Boolean).map(Number);

describe("lengths along the legs (F1 Q2 B, row F9)", () => {
  it("a bent course's exported LegLengths and Length equal the stored legs / length_m, in IOF and Purple Pen", async () => {
    const { id } = await caller.course.create({ name: "Export Bent" });
    await caller.course.setStructure({
      courseId: id,
      structure: {
        version: 1,
        id: "b",
        orderMode: "ordered",
        // Start (0, 0.5) → (10, 30) → 31 (20, 0.5): the leg runs along the bend.
        items: [{ siteId: 901 }, { siteId: 31, leg: { bends: [{ x: 10, y: 30 }] } }, { siteId: 32 }, { siteId: 902 }],
      },
    });
    const row = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: id } });
    const legs = storedLegs(row.legs);
    expect(legs).toHaveLength(3);
    // The bend lengthens the first leg well beyond the straight 20 mm.
    expect(legs[0]).toBeGreaterThan(Math.round((50 * mapScale) / 1000));

    const iof = parseIOFCourseData(await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name }));
    const exported = iof.courses.find((c) => c.name === "Export Bent")!;
    expect(exported.controls.slice(1).map((cc) => cc.legLength)).toEqual(legs);
    expect(exported.length).toBe(row.lengthM);

    // Purple Pen carries the bend as a <leg>; its parser measures along it too.
    const ppen = parsePpenCourseData(await buildEventPpenXml(ctx.db, { id: ctx.eventId, name: ctx.event.name }));
    const p = ppen.courses.find((c) => c.name === "Export Bent")!;
    expect(p.controls[1].bends).toEqual([{ x: 10, y: 30 }]);
    expect(p.controls.slice(1).map((cc) => cc.legLength)).toEqual(legs);
    await caller.course.delete({ id });
  });
});

describe("a forked event with a crossing point and a map exchange (row F9)", () => {
  let crossingId: number;

  beforeAll(async () => {
    await caller.control.create({ codes: "41", xpos: 30, ypos: 10 });
    await caller.control.create({ codes: "42", xpos: 30, ypos: 30 });
    await caller.control.create({ kind: "map_exchange", codes: "80", xpos: 70, ypos: 10 });
    crossingId = (await caller.control.create({ kind: "crossing_point", xpos: 85, ypos: 20 })).id;
    await caller.control.create({ kind: "map_issue", xpos: 50, ypos: 50 });
    const { id } = await caller.course.create({ name: "Fork" });
    await caller.course.setStructure({
      courseId: id,
      structure: {
        version: 1,
        id: "fork",
        orderMode: "ordered",
        items: [
          { siteId: 901 },
          { kind: "variation", id: "g", alternatives: [{ label: "A", items: [{ siteId: 41 }] }, { label: "B", items: [{ siteId: 42 }] }] },
          { siteId: 80 },
          { siteId: 902, leg: { crossing: { controlId: crossingId }, style: "marked_route", bends: [{ x: 80, y: 30 }] } },
        ],
      },
    });
    const cls = await caller.class.create({ name: "H21 Fork" });
    await caller.class.update({ id: cls.id, courseId: id });
  });

  async function variantRows() {
    const root = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, name: "Fork", removed: false, parentCourseId: null } });
    return ctx.db.course.findMany({ where: { parentCourseId: root.id, removed: false }, orderBy: { variantKey: "asc" } });
  }

  it("exports each variant as a Course of the root's family, and the class on the root to each", async () => {
    const xml = await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name });
    const parsed = parseIOFCourseData(xml);
    const names = parsed.courses.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Fork A", "Fork B"]));
    expect(names).not.toContain("Fork");
    expect(parsed.courses.filter((c) => c.family === "Fork").map((c) => c.name)).toEqual(["Fork A", "Fork B"]);
    expect(parsed.courses.find((c) => c.name === "Export A")!.family).toBeUndefined();
    expect(parsed.classAssignments.filter((a) => a.className === "H21 Fork")).toEqual([
      { className: "H21 Fork", courseName: "Fork A" },
      { className: "H21 Fork", courseName: "Fork B" },
    ]);
    expect(parsed.courses.find((c) => c.name === "Fork A")!.controls.map((cc) => cc.controlId)).toEqual(["901", "41", "80", "902"]);
    expect(parsed.courses.find((c) => c.name === "Fork B")!.controls.map((cc) => cc.controlId)).toEqual(["901", "42", "80", "902"]);
  });

  it("writes the crossing point, the taped route and the exchange marker; no map-issue point", async () => {
    const xml = await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name });
    const parsed = parseIOFCourseData(xml);
    expect(parsed.controls.find((c) => c.id === "Passeringspunkt 1")).toMatchObject({ type: "CrossingPoint", mapX: 85, mapY: 20 });
    expect(parsed.controls.find((c) => c.id === "80")!.mapExchange).toBe(true);
    expect(parsed.controls.some((c) => c.id.startsWith("Kartutdelning"))).toBe(false);
    expect(xml).toMatch(/<CourseControl type="CrossingPoint" specialInstruction="MandatoryCrossingPoint">\s*<Control>Passeringspunkt 1<\/Control>\s*<\/CourseControl>\s*<CourseControl type="Finish" specialInstruction="TapedRoute" tapedRouteLength="(\d+)">/);
    const a = parsed.courses.find((c) => c.name === "Fork A")!;
    const last = a.controls.at(-1)!;
    expect(last).toMatchObject({ crossing: { controlId: "Passeringspunkt 1" }, style: "marked_route" });
    const taped = Number(/tapedRouteLength="(\d+)"/.exec(xml)![1]);
    expect(taped).toBe(last.legLength);
  });

  it("every exported leg and length equals the variant row's stored legs / length_m (through the bend and the crossing)", async () => {
    const parsed = parseIOFCourseData(await buildEventCourseDataXml(ctx.db, { id: ctx.eventId, name: ctx.event.name }));
    for (const row of await variantRows()) {
      const exported = parsed.courses.find((c) => c.name === row.name)!;
      expect(exported.controls.slice(1).map((cc) => cc.legLength)).toEqual(storedLegs(row.legs));
      expect(exported.length).toBe(row.lengthM);
    }
  });

  it("Purple Pen: one kind=normal course per variant with the bend, no crossing point", async () => {
    const xml = await buildEventPpenXml(ctx.db, { id: ctx.eventId, name: ctx.event.name });
    expect(xml).not.toContain("Passeringspunkt");
    expect(xml).not.toContain("Kartutdelning");
    const parsed = parsePpenCourseData(xml);
    const names = parsed.courses.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Fork A", "Fork B"]));
    expect(names).not.toContain("Fork");
    for (const name of ["Fork A", "Fork B"]) {
      expect(parsed.courses.find((c) => c.name === name)!.controls.at(-1)!.bends).toEqual([{ x: 80, y: 30 }]);
    }
  });
});

/**
 * Importers write the structure (slice D, row D1; docs/course-layer.md §6.4):
 *
 *   - a real OCD file (e2e/test.ocd), a Purple Pen file and an IOF file each
 *     leave every imported course with a stored, explicit start → controls →
 *     finish structure mirrored into the flat columns
 *   - the rows the import wrote take the `reference.imported` entry's HLC as
 *     their token
 *   - a parsed OCD bundle with authored geometry: slits → `controls.circle_gaps`,
 *     705 pieces → `leg.gaps`, 707 / 708 / 709 / 711 → import-marked course
 *     objects; a re-import replaces them and leaves hand-drawn objects alone
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import type { ParsedCourseData } from "../../iof-course-parser.js";

const mocked = vi.hoisted(() => ({ parsed: null as unknown }));
vi.mock("../../ocd-course-parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ocd-course-parser.js")>();
  return { ...actual, parseOCDCourseData: (buf: Buffer) => (mocked.parsed ? (mocked.parsed as ParsedCourseData) : actual.parseOCDCourseData(buf)) };
});

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

const PPEN = `<?xml version="1.0" encoding="utf-8"?>
<course-scribe-event>
  <event id="1"><title>Ppen</title><map kind="OCAD" scale="10000">map.ocd</map></event>
  <control id="10" kind="start"><location x="10" y="20" /></control>
  <control id="11" kind="normal"><code>31</code><location x="30" y="40" /></control>
  <control id="12" kind="normal"><code>32</code><location x="50" y="60" /></control>
  <control id="13" kind="finish"><location x="70" y="20" /></control>
  <course id="1" kind="normal" order="1">
    <name>Ppen A</name>
    <first course-control="100" />
  </course>
  <course-control id="100" control="10"><next course-control="101" /></course-control>
  <course-control id="101" control="11"><next course-control="102" /></course-control>
  <course-control id="102" control="12"><next course-control="103" /></course-control>
  <course-control id="103" control="13" />
</course-scribe-event>`;

const IOF = `<?xml version="1.0" encoding="UTF-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <RaceCourseData>
    <Control type="Start"><Id>S1</Id><Position lng="11.0" lat="58.0"/></Control>
    <Control type="Control"><Id>41</Id><Position lng="11.001" lat="58.001"/></Control>
    <Control type="Control"><Id>42</Id><Position lng="11.002" lat="58.002"/></Control>
    <Control type="Finish"><Id>F1</Id><Position lng="11.003" lat="58.003"/></Control>
    <Course><Name>Iof A</Name><Length>1000</Length><Climb>10</Climb>
      <CourseControl type="Start"><Control>S1</Control></CourseControl>
      <CourseControl type="Control"><Control>41</Control></CourseControl>
      <CourseControl type="Control"><Control>42</Control></CourseControl>
      <CourseControl type="Finish"><Control>F1</Control></CourseControl>
    </Course>
  </RaceCourseData>
</CourseData>`;

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("course_import_structure");
  caller = makeCaller(ctx.event);
}, 60_000);

afterAll(async () => {
  mocked.parsed = null;
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

const courses = () => ctx.db.course.findMany({ where: { eventId: ctx.eventId, removed: false }, orderBy: { name: "asc" } });

/** Statuses of the sites of a stored structure (`ok` = a control). */
async function kindsOf(structure: unknown): Promise<string[]> {
  const items = (structure as { items: { siteId: string }[] }).items;
  const rows = await ctx.db.control.findMany({ where: { id: { in: items.map((i) => i.siteId) } }, select: { id: true, status: true } });
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  return items.map((i) => byId.get(i.siteId) ?? "?");
}

describe("importCourses writes a structure for every format", () => {
  it("OCD (e2e/test.ocd): stored, explicit start → controls → finish, mirrored", async () => {
    await caller.course.importCourses({ ocdBase64: readFileSync(FIXTURE).toString("base64") });
    const rows = await courses();
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) {
      expect(c.structure, c.name).not.toBeNull();
      const kinds = await kindsOf(c.structure);
      expect(kinds[0]).toBe("start");
      expect(kinds.at(-1)).toBe("finish");
      expect(c.finishControlId).not.toBeNull();
      const cc = await ctx.db.courseControl.count({ where: { courseId: c.id } });
      expect(cc).toBe(kinds.length - 2);
      const detail = await caller.course.detail({ id: c.seq });
      expect(detail.structureStored).toBe(true);
    }
  });

  it("Purple Pen and IOF files", async () => {
    await caller.course.importCourses({ xmlContent: PPEN, skipPositions: true });
    await caller.course.importCourses({ xmlContent: IOF });
    for (const name of ["Ppen A", "Iof A"]) {
      const c = (await courses()).find((x) => x.name === name)!;
      expect(c, name).toBeDefined();
      expect(await kindsOf(c.structure)).toEqual(["start", "ok", "ok", "finish"]);
    }
  });

  it("the written rows hold the reference.imported entry's HLC as their token", async () => {
    await caller.course.importCourses({ xmlContent: IOF });
    const entry = await ctx.db.journalEntry.findFirstOrThrow({ where: { eventId: ctx.eventId, type: "reference.imported" }, orderBy: { hlc: "desc" } });
    const c = (await courses()).find((x) => x.name === "Iof A")!;
    expect(c.version).toBe(entry.hlc);
    const payload = entry.payload as { courses: { id: string; fields: { version?: unknown } }[] };
    expect(String(payload.courses.find((p) => p.id === c.id)!.fields.version)).toBe(entry.hlc.toString());
    const ctl = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "41" } });
    expect(ctl.version).toBe(entry.hlc);
  });
});

describe("an OCD bundle with authored geometry", () => {
  const A = { x: 0, y: 0 };
  const B = { x: 100, y: 0 };
  const pt = (id: string, type: "Start" | "Control" | "Finish", p = A, cuts?: { start: number; end: number }[]) => ({
    id, type, lat: 0, lng: 0, mapX: p.x, mapY: p.y, ...(cuts ? { cuts } : {}),
  });
  const line = (symbolType: string, coordinates: number[][], extra: Record<string, unknown> = {}) => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { symbolType, ...extra } });
  const bundle = (): ParsedCourseData => ({
    controls: [pt("STA1", "Start", { x: -10, y: 0 }), pt("71", "Control", A, [{ start: 10, end: 40 }]), pt("72", "Control", B), pt("FIN1", "Finish", { x: 110, y: 0 })],
    courses: [{ name: "Gapped", length: 1000, climb: 10, controls: [
      { controlId: "STA1", type: "Start", legLength: 0 }, { controlId: "71", type: "Control", legLength: 100 },
      { controlId: "72", type: "Control", legLength: 100 }, { controlId: "FIN1", type: "Finish", legLength: 10 },
    ] }],
    classAssignments: [],
    mapScale: 10000,
    mapFeatures: [],
    geometrySource: "ocd",
    courseGeometry: {
      Gapped: {
        type: "FeatureCollection",
        features: [
          line("leg", [[5, 0], [40, 0]], { from: "71", to: "72", preclipped: true }),
          line("leg", [[60, 0], [95, 0]], { from: "71", to: "72", preclipped: true }),
          line("marked_route", [[1, 1], [2, 2]]),
          line("restricted_line", [[3, 3], [4, 4]]),
          line("forbidden_route", [[5, 5], [6, 6]]),
          { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 0]]] }, properties: { symbolType: "restricted_area" } },
        ],
      },
    },
  } as unknown as ParsedCourseData);
  const importIt = () => caller.course.importCourses({ ocdBase64: "AA==" });

  it("slits → circle_gaps, pieces → leg.gaps, lines and areas → import-marked objects", async () => {
    mocked.parsed = bundle();
    await importIt();
    const c = (await courses()).find((x) => x.name === "Gapped")!;
    const items = (c.structure as { items: { siteId: string; leg?: { gaps: unknown[] } }[] }).items;
    expect(items).toHaveLength(4);
    expect(items[2].leg).toEqual({ gaps: [{ from: 0.4, to: 0.6 }] });
    expect(items[1].leg).toBeUndefined();
    const ctl = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "71" } });
    expect(ctl.circleGaps).toEqual([{ start: 10, end: 40 }]);
    const objs = await ctx.db.courseObject.findMany({ where: { eventId: ctx.eventId }, orderBy: { seq: "asc" } });
    expect(objs.map((o) => [o.kind, o.props, o.source])).toEqual([
      ["marked_route", {}, "import"], ["oob_line", {}, "import"], ["oob_line", { symbol: "711" }, "import"], ["oob_area", {}, "import"],
    ]);
    expect(objs[0].scope).toEqual({ courses: [c.id], classes: [] });
    expect(objs[1].scope).toEqual({ courses: [c.id], classes: [] });
    // The polygon's closing vertex is dropped.
    expect(objs[3].geometry).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
  });

  it("a re-import replaces the import-marked objects of its courses, keeps a hand-drawn one and another file's; the file's cuts are the effective set", async () => {
    const elsewhere = await ctx.db.courseObject.create({
      data: { eventId: ctx.eventId, kind: "oob_line", geometry: [{ x: 7, y: 7 }, { x: 6, y: 6 }], props: {}, scope: { courses: ["00000000-0000-4000-8000-0000000000ff"], classes: [] }, source: "import" },
    });
    const hand = await ctx.db.courseObject.create({
      data: { eventId: ctx.eventId, kind: "oob_line", geometry: [{ x: 9, y: 9 }, { x: 8, y: 8 }], props: {}, scope: { all: true } },
    });
    const next = bundle();
    next.controls = next.controls.map((c) => (c.id === "71" ? { ...c, cuts: undefined } : c));
    mocked.parsed = next;
    await importIt();
    const objs = await ctx.db.courseObject.findMany({ where: { eventId: ctx.eventId } });
    expect(objs.filter((o) => o.source === "import")).toHaveLength(5); // the file's 4 + the other file's
    expect(objs.find((o) => o.id === hand.id)).toBeDefined();
    expect(objs.find((o) => o.id === elsewhere.id)).toBeDefined();
    const ctl = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "71" } });
    expect(ctl.circleGaps).toEqual([]);
  });
});

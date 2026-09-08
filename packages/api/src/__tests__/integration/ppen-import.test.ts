/**
 * Integration: Purple Pen (.ppen) import through previewImport / importCourses.
 *
 * The client sends the file as `xmlContent`; parseCourseFile sniffs the
 * `<course-scribe-event>` root and routes to the ppen parser.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Paper mm extent: x −76.4…76.4, y −48.4…46.4, scale 1:7500. */
const MAP_FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

const PPEN = `<?xml version="1.0" encoding="utf-8"?>
<course-scribe-event>
  <event id="1">
    <title>Ppen Import</title>
    <map kind="OCAD" scale="10000">map.ocd</map>
  </event>
  <control id="10" kind="start">
    <location x="10" y="20" />
  </control>
  <control id="11" kind="normal">
    <code>31</code>
    <location x="30" y="40" />
  </control>
  <control id="12" kind="normal">
    <code>32</code>
    <location x="50" y="60" />
  </control>
  <control id="14" kind="finish">
    <location x="90" y="100" />
  </control>
  <course id="1" kind="normal" order="1">
    <name>Ppen A</name>
    <first course-control="100" />
  </course>
  <course-control id="100" control="10">
    <next course-control="101" />
  </course-control>
  <course-control id="101" control="11">
    <next course-control="102" />
  </course-control>
  <course-control id="102" control="12">
    <next course-control="103" />
  </course-control>
  <course-control id="103" control="14" />
</course-scribe-event>
`;

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("ppen_import");
  caller = makeCaller(ctx.event);
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

describe("course.previewImport / importCourses — Purple Pen", () => {
  it("previews courses and falls back to course-name class suggestions", async () => {
    await ctx.db.class.create({
      data: { eventId: ctx.eventId, name: "Ppen A", sortIndex: 1 },
    });

    const preview = await caller.course.previewImport({ xmlContent: PPEN });
    expect(preview.courses).toHaveLength(1);
    expect(preview.courses[0].name).toBe("Ppen A");
    expect(preview.classNamesFromCourseNames).toBe(true);
    expect(preview.courses[0].xmlClassNames).toContain("Ppen A");
  });

  it("imports controls and course sequence with map-mm positions", async () => {
    const res = await caller.course.importCourses({
      xmlContent: PPEN,
      replaceAll: true,
    });
    expect(res.coursesCreated).toBeGreaterThanOrEqual(1);

    const courses = await caller.course.list();
    const course = courses.find((c) => c.name === "Ppen A");
    expect(course).toBeDefined();

    const detail = await caller.course.detail({ id: course!.id });
    // Regular controls only in the join table; start/finish are separate.
    const codes = detail.controlCodes.map((c) =>
      typeof c === "string" ? c : c.code,
    );
    expect(codes).toEqual(expect.arrayContaining(["31", "32"]));

    const coords = await caller.course.controlCoordinates();
    const byPos = coords.filter((c) => c.mapX !== 0 || c.mapY !== 0);
    expect(byPos.some((c) => Math.abs(c.mapX - 30) < 0.01 && Math.abs(c.mapY - 40) < 0.01)).toBe(
      true,
    );
    expect(byPos.some((c) => Math.abs(c.mapX - 50) < 0.01 && Math.abs(c.mapY - 60) < 0.01)).toBe(
      true,
    );
  });
});

/**
 * Coordinate anchoring. Purple Pen positions are paper mm measured on
 * one specific map file, so importing them against a different map has
 * to be detected — and fixed when Oxygen has the map they came from.
 */
describe("course.previewImport — Purple Pen coordinate alignment", () => {
  const suffix = randomBytes(4).toString("hex");
  let mapCtx: TestEventContext;
  let mapCaller: ReturnType<typeof makeCaller>;
  /** Own event for the position-less import, so nothing is revived. */
  let skipCtx: TestEventContext;
  let skipCaller: ReturnType<typeof makeCaller>;
  const clubMapIds: bigint[] = [];

  /** A one-course file placed at `x`/`y`, set on `mapName`. */
  const ppenOn = (mapName: string, x: number, y: number, code = 71) => `<?xml version="1.0" encoding="utf-8"?>
<course-scribe-event>
  <event id="1">
    <title>Alignment</title>
    <map kind="OCAD" scale="7500">${mapName}</map>
  </event>
  <control id="10" kind="start"><location x="${x}" y="${y}" /></control>
  <control id="11" kind="normal"><code>${code}</code><location x="${x + 5}" y="${y + 5}" /></control>
  <control id="12" kind="finish"><location x="${x + 10}" y="${y + 10}" /></control>
  <course id="1" kind="normal" order="1">
    <name>Align A</name>
    <first course-control="100" />
  </course>
  <course-control id="100" control="10"><next course-control="101" /></course-control>
  <course-control id="101" control="11"><next course-control="102" /></course-control>
  <course-control id="102" control="12" />
</course-scribe-event>`;

  beforeAll(async () => {
    mapCtx = await createTestEvent("ppen_align");
    mapCaller = makeCaller(mapCtx.event);
    const mapBase64 = readFileSync(MAP_FIXTURE).toString("base64");
    await mapCaller.course.uploadMap({
      fileName: "event-map.ocd",
      fileDataBase64: mapBase64,
    });

    skipCtx = await createTestEvent("ppen_skip_pos");
    skipCaller = makeCaller(skipCtx.event);
    await skipCaller.course.uploadMap({
      fileName: "event-map.ocd",
      fileDataBase64: mapBase64,
    });
  }, 60_000);

  afterAll(async () => {
    if (clubMapIds.length) {
      await mapCtx.db.clubMapFile.deleteMany({
        where: { id: { in: clubMapIds } },
      });
    }
    await mapCtx?.cleanup();
    await skipCtx?.cleanup();
  }, 30_000);

  it("treats the event's own map as aligned", async () => {
    const preview = await mapCaller.course.previewImport({
      xmlContent: ppenOn("event-map.ocd", 10, 10),
    });
    expect(preview.coordinateAlignment).toBe("aligned");
    expect(preview.sourceMapName).toBe("event-map.ocd");
    expect(preview.eventMapName).toBe("event-map.ocd");
  });

  it("accepts another map's name when the positions land on the map", async () => {
    const preview = await mapCaller.course.previewImport({
      xmlContent: ppenOn("renamed-copy.ocd", 10, 10),
    });
    expect(preview.coordinateAlignment).toBe("aligned");
  });

  it("flags positions that belong to a map Oxygen does not have", async () => {
    const preview = await mapCaller.course.previewImport({
      xmlContent: ppenOn("somewhere-else.ocd", -900, -400),
    });
    expect(preview.coordinateAlignment).toBe("mismatch");
    expect(preview.sourceMapName).toBe("somewhere-else.ocd");
    expect(preview.eventMapName).toBe("event-map.ocd");
  });

  it("re-projects from the source map when the club library has it", async () => {
    const libraryName = `library-${suffix}.ocd`;
    const uploaded = await makeCaller().clubMap.upload({
      fileName: libraryName,
      name: `Alignment source ${suffix}`,
      fileDataBase64: readFileSync(MAP_FIXTURE).toString("base64"),
    });
    clubMapIds.push(BigInt(uploaded.id));

    const preview = await mapCaller.course.previewImport({
      xmlContent: ppenOn(libraryName, -900, -400),
    });
    expect(preview.coordinateAlignment).toBe("transformed");
    expect(preview.alignedFromMapName).toBe(`Alignment source ${suffix}`);

    // Club map and event map are the same file here, so the round trip
    // through WGS84 must return the coordinates it was given.
    await mapCaller.course.importCourses({
      xmlContent: ppenOn(libraryName, -900, -400),
      replaceAll: true,
    });
    const coords = await mapCaller.course.controlCoordinates();
    const start = coords.find((c) => c.mapX < -800);
    expect(start).toBeDefined();
    expect(start!.mapX).toBeCloseTo(-900, 1);
    expect(start!.mapY).toBeCloseTo(-400, 1);
  }, 60_000);

  it("imports codes and sequence without positions when asked", async () => {
    const res = await skipCaller.course.importCourses({
      xmlContent: ppenOn("somewhere-else.ocd", -900, -400, 81),
      replaceAll: true,
      skipPositions: true,
    });
    expect(res.coursesCreated).toBe(1);
    expect(res.coordinateAlignment).toBe("skipped");

    const courses = await skipCaller.course.list();
    const course = courses.find((c) => c.name === "Align A");
    expect(course).toBeDefined();
    const detail = await skipCaller.course.detail({ id: course!.id });
    expect(
      detail.controlCodes.map((c) => (typeof c === "string" ? c : c.code)),
    ).toContain("81");

    // Controls arrive unplaced — the course editor is where they get
    // positions — and no geometry is drawn from the file's coordinates.
    const rows = await skipCtx.db.control.findMany({
      where: { eventId: skipCtx.eventId, removed: false },
      select: { xpos: true, ypos: true, lat: true, lng: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.xpos).toBe(0);
      expect(r.ypos).toBe(0);
      expect(r.lat).toBeNull();
      expect(r.lng).toBeNull();
    }

    const row = await skipCtx.db.course.findFirst({
      where: { eventId: skipCtx.eventId, name: "Align A", removed: false },
      select: { geometry: true, lengthM: true },
    });
    const features =
      (row?.geometry as { features?: unknown[] } | null)?.features ?? [];
    expect(features).toHaveLength(0);
    // Leg lengths came from the file's own map scale and stay valid.
    expect(row!.lengthM).toBeGreaterThan(0);
  }, 60_000);
});

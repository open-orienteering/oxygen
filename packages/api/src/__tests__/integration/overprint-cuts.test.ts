/**
 * Integration tests for automatic overprint cuts: circle slits and leg
 * gaps computed from the base map at geometry-rebuild time.
 *
 * Uses the synthetic OCAD fixture's known features in the otherwise
 * empty top-right corner (see `scripts/generate-test-ocd.mjs`): a boulder
 * (ISOM 204) at 68/42 mm and a building (ISOM 521) spanning
 * 48–58 / 39–46 mm. `legacy` events cut against the OCAD parse; `vector`
 * events against the pinned map document (docs/course-layer.md §4).
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
import type { GeoJSONFeatureCollection } from "../../iof-course-parser.js";
import { OVERPRINT_CUTS_VERSION } from "../../course-geometry.js";
import { applyEventMap } from "../../event-map.js";
import { loadEventCutFeatures } from "../../event-map-objects.js";
import { buildGeometryReport, formatGeometryReport, reportTotals } from "../../course-geometry-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("overprint_cuts");
  caller = makeCaller(ctx.event);
  const buf = readFileSync(FIXTURE);
  await caller.course.uploadMap({
    fileName: "test.ocd",
    fileDataBase64: buf.toString("base64"),
  });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

async function storedGeometry(courseSeq: number): Promise<GeoJSONFeatureCollection> {
  const row = await ctx.db.course.findFirst({
    where: { eventId: ctx.eventId, seq: courseSeq },
    select: { geometry: true, geometrySource: true },
  });
  expect(row?.geometrySource).toBe("editor");
  return row!.geometry as unknown as GeoJSONFeatureCollection;
}

describe("automatic overprint cuts in editor geometry", () => {
  it("slits a control circle whose rim passes over the boulder", async () => {
    // 2.5 mm south of the boulder: the boulder sits due north on the rim.
    await caller.control.create({ codes: "161", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "162", xpos: 90, ypos: 60 }); // empty area
    const course = await caller.course.create({
      name: "Cuts-A",
      controlIds: [161, 162],
    });

    const geom = await storedGeometry(course.id);
    const onBoulder = geom.features.find((f) => f.properties.code === "161");
    const inEmpty = geom.features.find((f) => f.properties.code === "162");
    const cuts = onBoulder?.properties.cuts as Array<{ start: number; end: number }>;
    expect(cuts).toHaveLength(1);
    // Slit spans compass north (start just below 360, end just above 0).
    expect(cuts[0].start).toBeGreaterThan(300);
    expect(cuts[0].end).toBeLessThan(60);
    expect(inEmpty?.properties.cuts).toBeUndefined();
  });

  it("does not gap a leg crossing a building", async () => {
    await caller.control.create({ codes: "163", xpos: 44, ypos: 42 });
    await caller.control.create({ codes: "164", xpos: 64, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-B",
      controlIds: [163, 164],
    });

    const geom = await storedGeometry(course.id);
    const leg = geom.features.find(
      (f) => f.properties.from === "163" && f.properties.to === "164",
    );
    expect(leg?.properties.gaps).toBeUndefined();
  });

  it("gaps a leg crossing the boulder", async () => {
    await caller.control.create({ codes: "167", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "168", xpos: 76, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-Boulder-Leg",
      controlIds: [167, 168],
    });

    const geom = await storedGeometry(course.id);
    const leg = geom.features.find(
      (f) => f.properties.from === "167" && f.properties.to === "168",
    );
    const gaps = leg?.properties.gaps as Array<{ from: number; to: number }>;
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

    let geom = await storedGeometry(course.id);
    let f = geom.features.find((x) => x.properties.code === "165");
    expect(f?.properties.cuts).toBeUndefined();

    // Move 165 onto the boulder rim.
    await caller.control.update({ id: 165, xpos: 68, ypos: 39.5 });
    geom = await storedGeometry(course.id);
    f = geom.features.find((x) => x.properties.code === "165");
    expect(f?.properties.cuts).toHaveLength(1);

    // And away again: cuts disappear.
    await caller.control.update({ id: 165, xpos: 90, ypos: 30 });
    geom = await storedGeometry(course.id);
    f = geom.features.find((x) => x.properties.code === "165");
    expect(f?.properties.cuts).toBeUndefined();
  });

  it("uploading a map rebuilds editor course geometry with cuts", async () => {
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
      let row = await other.db.course.findFirst({
        where: { eventId: other.eventId, seq: course.id },
        select: { geometry: true },
      });
      let geom = row!.geometry as unknown as GeoJSONFeatureCollection;
      expect(
        geom.features.find((f) => f.properties.code === "171")?.properties.cuts,
      ).toBeUndefined();

      const buf = readFileSync(FIXTURE);
      await otherCaller.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: buf.toString("base64"),
      });

      row = await other.db.course.findFirst({
        where: { eventId: other.eventId, seq: course.id },
        select: { geometry: true },
      });
      geom = row!.geometry as unknown as GeoJSONFeatureCollection;
      expect(
        geom.features.find((f) => f.properties.code === "171")?.properties.cuts,
      ).toHaveLength(1);
    } finally {
      await other.cleanup();
    }
  });

  it("lazily rebuilds editor geometry stored by the previous cut algorithm", async () => {
    const other = await createTestEvent("overprint_cuts_version");
    try {
      const otherCaller = makeCaller(other.event);
      await otherCaller.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: readFileSync(FIXTURE).toString("base64"),
      });
      await otherCaller.control.create({ codes: "175", xpos: 44, ypos: 42 });
      await otherCaller.control.create({ codes: "176", xpos: 64, ypos: 42 });
      const course = await otherCaller.course.create({
        name: "Legacy long-object gap",
        controlIds: [175, 176],
      });
      const row = await other.db.course.findFirstOrThrow({
        where: { eventId: other.eventId, seq: course.id },
      });
      const stale = row.geometry as unknown as GeoJSONFeatureCollection;
      const leg = stale.features.find(
        (feature) =>
          feature.properties.from === "175" &&
          feature.properties.to === "176",
      );
      leg!.properties.gaps = [{ from: 0.2, to: 0.7 }];
      await other.db.course.update({
        where: { id: row.id },
        data: { geometry: stale as never },
      });
      await other.db.event.update({
        where: { id: other.eventId },
        data: { overprintCutsVersion: 1 },
      });

      const rebuilt = await otherCaller.course.geometry({ id: course.id });
      const rebuiltLeg = rebuilt.features.find(
        (feature) =>
          (feature as GeoJSONFeatureCollection["features"][number]).properties
            .from === "175",
      ) as GeoJSONFeatureCollection["features"][number];
      expect(rebuiltLeg.properties.gaps).toBeUndefined();
      expect(
        (
          await other.db.event.findUniqueOrThrow({
            where: { id: other.eventId },
          })
        ).overprintCutsVersion,
      ).toBe(OVERPRINT_CUTS_VERSION);
    } finally {
      await other.cleanup();
    }
  });

  it("setOverprintCuts(false) strips cuts/gaps; true restores them", async () => {
    await caller.control.create({ codes: "181", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "182", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "183", xpos: 76, ypos: 42 });
    const course = await caller.course.create({
      name: "Cuts-Toggle",
      controlIds: [181, 182, 183],
    });

    let geom = await storedGeometry(course.id);
    expect(
      geom.features.find((f) => f.properties.code === "181")?.properties.cuts,
    ).toHaveLength(1);
    expect(
      geom.features.find(
        (f) => f.properties.from === "182" && f.properties.to === "183",
      )?.properties.gaps,
    ).toHaveLength(1);

    const off = await caller.course.setOverprintCuts({ enabled: false });
    expect(off.enabled).toBe(false);
    expect((await caller.course.getOverprintCuts()).enabled).toBe(false);

    geom = await storedGeometry(course.id);
    expect(
      geom.features.find((f) => f.properties.code === "181")?.properties.cuts,
    ).toBeUndefined();
    expect(
      geom.features.find(
        (f) => f.properties.from === "182" && f.properties.to === "183",
      )?.properties.gaps,
    ).toBeUndefined();

    const on = await caller.course.setOverprintCuts({ enabled: true });
    expect(on.enabled).toBe(true);
    geom = await storedGeometry(course.id);
    expect(
      geom.features.find((f) => f.properties.code === "181")?.properties.cuts,
    ).toHaveLength(1);
    expect(
      geom.features.find(
        (f) => f.properties.from === "182" && f.properties.to === "183",
      )?.properties.gaps,
    ).toHaveLength(1);
  });
});

describe("vector events cut against the pinned document", () => {
  let vec: TestEventContext;
  let vecCaller: ReturnType<typeof makeCaller>;
  let documentHash: string;
  let uploadCourseSeq: number;

  beforeAll(async () => {
    vec = await createTestEvent("overprint_cuts_vector");
    vecCaller = makeCaller(vec.event);
    await vec.db.event.update({ where: { id: vec.eventId }, data: { mapPipeline: "vector" } });
    // A course on the boulder before any map: rebuilt by the upload below.
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

  const vecGeometry = async (seq: number) => {
    const row = await vec.db.course.findFirstOrThrow({ where: { eventId: vec.eventId, seq }, select: { geometry: true, geometrySource: true } });
    expect(row.geometrySource).toBe("editor");
    return row.geometry as unknown as GeoJSONFeatureCollection;
  };

  it("reads the document's features, the same knolls and rocks as the OCAD parse", async () => {
    const fromDoc = await loadEventCutFeatures(vec.db, vec.eventId, 15000);
    const fromOcad = await loadEventCutFeatures(ctx.db, ctx.eventId, 15000);
    expect(fromDoc?.source).toBe("document");
    expect(fromOcad?.source).toBe("ocad");
    const key = (f: { x: number; y: number }) => `${f.x.toFixed(3)},${f.y.toFixed(3)}`;
    expect(fromDoc!.features.map(key).sort()).toEqual(fromOcad!.features.map(key).sort());
    const boulder = (fs: Array<{ x: number; y: number; r?: number }>) => fs.find((f) => Math.abs(f.x - 68) < 1e-3 && Math.abs(f.y - 42) < 1e-3);
    expect(boulder(fromDoc!.features)?.r).toBeCloseTo(boulder(fromOcad!.features)!.r!, 6);
  });

  it("the upload rebuild cut the course created before the map", async () => {
    const cuts = (await vecGeometry(uploadCourseSeq)).features.find((f) => f.properties.code === "191")?.properties.cuts;
    expect(cuts).toHaveLength(1);
  });

  it("cuts a circle and a leg as the legacy event does, within rounding", async () => {
    await vecCaller.control.create({ codes: "193", xpos: 68, ypos: 39.5 });
    await vecCaller.control.create({ codes: "194", xpos: 60, ypos: 42 });
    await vecCaller.control.create({ codes: "195", xpos: 76, ypos: 42 });
    const vecCourse = await vecCaller.course.create({ name: "Vec-Cuts", controlIds: [193, 194, 195] });
    await caller.control.create({ codes: "196", xpos: 68, ypos: 39.5 });
    await caller.control.create({ codes: "197", xpos: 60, ypos: 42 });
    await caller.control.create({ codes: "198", xpos: 76, ypos: 42 });
    const legacyCourse = await caller.course.create({ name: "Legacy-Cuts", controlIds: [196, 197, 198] });

    const v = await vecGeometry(vecCourse.id);
    const l = await storedGeometry(legacyCourse.id);
    const vCuts = v.features.find((f) => f.properties.code === "193")!.properties.cuts as Array<{ start: number; end: number }>;
    const lCuts = l.features.find((f) => f.properties.code === "196")!.properties.cuts as Array<{ start: number; end: number }>;
    expect(vCuts).toHaveLength(1);
    expect(vCuts[0].start).toBeCloseTo(lCuts[0].start, 6);
    expect(vCuts[0].end).toBeCloseTo(lCuts[0].end, 6);
    const vGaps = v.features.find((f) => f.properties.from === "194")!.properties.gaps as Array<{ from: number; to: number }>;
    const lGaps = l.features.find((f) => f.properties.from === "197")!.properties.gaps as Array<{ from: number; to: number }>;
    expect(vGaps).toHaveLength(1);
    expect(vGaps[0].from).toBeCloseTo(lGaps[0].from, 6);
    expect(vGaps[0].to).toBeCloseTo(lGaps[0].to, 6);
  });

  it("falls back to the OCAD parse while no document is pinned", async () => {
    await vec.db.mapFile.updateMany({ where: { eventId: vec.eventId }, data: { documentHash: null } });
    try {
      expect((await loadEventCutFeatures(vec.db, vec.eventId, 15000))?.source).toBe("ocad");
      // Away and back: only a position change rebuilds.
      await vecCaller.control.update({ id: 191, xpos: 90, ypos: 30 });
      await vecCaller.control.update({ id: 191, xpos: 68, ypos: 39.5 });
      const cuts = (await vecGeometry(uploadCourseSeq)).features.find((f) => f.properties.code === "191")?.properties.cuts;
      expect(cuts).toHaveLength(1);
    } finally {
      await vec.db.mapFile.updateMany({ where: { eventId: vec.eventId }, data: { documentHash } });
    }
  });

  it("migrates geometry stored by the previous version from the document", async () => {
    const row = await vec.db.course.findFirstOrThrow({ where: { eventId: vec.eventId, seq: uploadCourseSeq } });
    const stale = row.geometry as unknown as GeoJSONFeatureCollection;
    const control = stale.features.find((f) => f.properties.code === "191")!;
    control.properties.cuts = [{ start: 170, end: 190 }];
    await vec.db.course.update({ where: { id: row.id }, data: { geometry: stale as never } });
    await vec.db.event.update({ where: { id: vec.eventId }, data: { overprintCutsVersion: 2 } });

    const rebuilt = await vecCaller.course.geometry({ id: uploadCourseSeq });
    const cuts = (rebuilt.features as GeoJSONFeatureCollection["features"]).find((f) => f.properties.code === "191")!.properties.cuts as Array<{ start: number; end: number }>;
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBeGreaterThan(300); // north again, not the planted 170–190°
    expect((await vec.db.event.findUniqueOrThrow({ where: { id: vec.eventId } })).overprintCutsVersion).toBe(OVERPRINT_CUTS_VERSION);
  });

  it("comparison report: stored editor geometry equals what C5 writes; imported fidelity counted", async () => {
    // An imported OCD course on the legacy event: one leg bent round something, a file-authored slit.
    await ctx.db.course.create({
      data: {
        eventId: ctx.eventId,
        name: "Imported-OCD",
        geometrySource: "ocd",
        geometry: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: [60, 20] }, properties: { symbolType: "start", code: "S1" } },
            { type: "Feature", geometry: { type: "Point", coordinates: [68, 39.5] }, properties: { symbolType: "control", code: "31", cuts: [{ start: 350, end: 10 }] } },
            { type: "Feature", geometry: { type: "LineString", coordinates: [[61, 23], [66, 30], [67.5, 36]] }, properties: { symbolType: "leg", from: "S1", to: "31", preclipped: true } },
          ],
        },
      },
    });
    const report = await buildGeometryReport(ctx.db, { eventNameIds: [ctx.nameId, vec.nameId] });
    const t = reportTotals(report);
    expect(t.events).toBe(2);
    expect(t.editorCourses).toBeGreaterThan(5);
    expect(t.staleCourses).toBe(0);
    expect(t.circles.same).toBe(t.circles.compared);
    expect(t.legs.same).toBe(t.legs.compared);
    // The vector event's courses cut identically from the document and from the OCAD parse.
    expect(t.documentVsOcad.courses).toBeGreaterThan(0);
    expect(t.documentVsOcad.differing).toBe(0);
    expect(t.importedCourses).toBe(1);
    expect(t.imported).toMatchObject({ legs: 1, preclippedLegs: 1, bentLegs: 1, authoredCutControls: 1, both: 1 });
    expect(report.events.map((e) => [e.pipeline, e.cutSource])).toEqual([["legacy", "ocad"], ["vector", "document"]]);
    expect(formatGeometryReport(report)).toContain("| circle cuts |");
  });
});

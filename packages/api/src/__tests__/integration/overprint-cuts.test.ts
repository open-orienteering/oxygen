/**
 * Integration tests for automatic overprint cuts: circle slits and leg
 * gaps computed from the base map at geometry-rebuild time.
 *
 * Uses the synthetic OCAD fixture's known black features in the otherwise
 * empty top-right corner (see `scripts/generate-test-ocd.mjs`): a boulder
 * (ISOM 204) at 68/42 mm and a building (ISOM 521) spanning
 * 48–58 / 39–46 mm.
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

  it("gaps a leg crossing the building", async () => {
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
    const gaps = leg?.properties.gaps as Array<{ from: number; to: number }>;
    expect(gaps).toHaveLength(1);
    // Building spans x 48–58 on the 44→64 leg → fractions ≈ 0.2–0.7.
    expect(gaps[0].from).toBeCloseTo(0.2, 1);
    expect(gaps[0].to).toBeCloseTo(0.7, 1);
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
});

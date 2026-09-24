/**
 * Integration tests for automatic overprint cuts: circle slits and leg
 * gaps computed from the base map at geometry-rebuild time.
 *
 * Uses the synthetic OCAD fixture's known features in the otherwise
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
      ).toBe(2);
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

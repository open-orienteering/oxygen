/**
 * Paper-mm transfer between two georeferenced maps.
 *
 * The scenario this guards: courses set in Purple Pen on one map file,
 * imported into an event that uses a different map of the same terrain.
 * Both files describe the same ground, but their paper origins sit at
 * different reference points, so the raw millimetres must be moved.
 */

import { describe, it, expect } from "vitest";
import type { OcadCrs } from "../map-projection.js";
import {
  transferPaperMm,
  transferParsedCoordinates,
} from "../map-coordinate-transfer.js";
import type { ParsedCourseData } from "../iof-course-parser.js";

/** A SWEREF99 TM map whose paper origin sits at (easting, northing). */
function crs(
  easting: number,
  northing: number,
  scale = 15000,
  code = 3006,
): OcadCrs {
  return {
    easting,
    northing,
    scale,
    grivation: 0,
    code,
    catalog: "EPSG",
    toProjectedCoord([x, y]: number[]): number[] {
      const factor = scale / 100_000;
      return [x * factor + easting, y * factor + northing];
    },
  };
}

// Two Nacka-area maps, reference points 8 km apart in easting and
// 1 km in northing — the real-world spread that put imported controls
// off the map.
const SOURCE = crs(687000, 6574000);
const TARGET = crs(679000, 6575000);

describe("transferPaperMm", () => {
  it("re-anchors a point onto the target map's paper origin", () => {
    // Source paper (0, 0) is the source map's reference point:
    // 8 km east and 1 km south of the target's, i.e. +533.3 mm / -66.7 mm
    // of target paper at 1:15000.
    const t = transferPaperMm(0, 0, SOURCE, TARGET);
    expect(t).not.toBeNull();
    expect(t!.xMm).toBeCloseTo(8000 / 15, 1);
    expect(t!.yMm).toBeCloseTo(-1000 / 15, 1);
  });

  it("carries the real-world position, so a round trip is lossless", () => {
    const there = transferPaperMm(-190, -28, SOURCE, TARGET)!;
    const back = transferPaperMm(there.xMm, there.yMm, TARGET, SOURCE)!;
    expect(back.xMm).toBeCloseTo(-190, 3);
    expect(back.yMm).toBeCloseTo(-28, 3);
  });

  it("reports the WGS84 position it passed through", () => {
    const t = transferPaperMm(0, 0, SOURCE, TARGET)!;
    // 687000 E / 6574000 N in SWEREF99 TM is eastern Nacka.
    expect(t.lat).toBeCloseTo(59.28, 1);
    expect(t.lng).toBeCloseTo(18.28, 1);
  });

  it("returns null when a grid cannot be projected", () => {
    const unknown = crs(10, 20, 15000, 0);
    expect(transferPaperMm(5, 5, unknown, TARGET)).toBeNull();
    expect(transferPaperMm(5, 5, SOURCE, unknown)).toBeNull();
  });
});

describe("transferParsedCoordinates", () => {
  const parsed: ParsedCourseData = {
    controls: [
      { id: "31", type: "Control", lat: 0, lng: 0, mapX: -190, mapY: -28 },
      { id: "32", type: "Control", lat: 0, lng: 0, mapX: 0, mapY: 0 },
    ],
    courses: [],
    classAssignments: [],
    mapScale: 15000,
    sourceMap: { fileName: "source.ocd", kind: "OCAD", scale: 15000 },
    courseGeometry: {
      A: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[-190, -28], [-180, -20]] },
            properties: { symbolType: "leg" },
          },
        ],
      },
    },
    mapFeatures: [],
    geometrySource: "xml",
  };

  it("moves controls and course geometry together", () => {
    const moved = transferParsedCoordinates(parsed, SOURCE, TARGET)!;
    const expected = transferPaperMm(-190, -28, SOURCE, TARGET)!;

    expect(moved.controls[0].mapX).toBeCloseTo(expected.xMm, 6);
    expect(moved.controls[0].mapY).toBeCloseTo(expected.yMm, 6);
    expect(moved.controls[0].lat).toBeCloseTo(expected.lat, 9);

    const line = moved.courseGeometry.A.features[0].geometry;
    expect(line.type).toBe("LineString");
    expect((line as { coordinates: number[][] }).coordinates[0][0]).toBeCloseTo(
      expected.xMm,
      6,
    );
  });

  it("leaves unplaced controls alone and adopts the target scale", () => {
    const moved = transferParsedCoordinates(parsed, SOURCE, TARGET)!;
    expect(moved.controls[1].mapX).toBe(0);
    expect(moved.controls[1].mapY).toBe(0);
    expect(moved.mapScale).toBe(TARGET.scale);
  });

  it("returns null rather than half-moved data on an unusable grid", () => {
    expect(transferParsedCoordinates(parsed, crs(10, 20, 15000, 0), TARGET)).toBeNull();
  });
});

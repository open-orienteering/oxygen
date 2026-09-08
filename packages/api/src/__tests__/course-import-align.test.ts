/**
 * Pure helpers behind the course-import coordinate alignment check.
 */

import { describe, it, expect } from "vitest";
import { sameMapFile, positionsOffMap } from "../course-import-align.js";
import type { MapCalibrationPoint } from "../event-map.js";

/** Corners of the synthetic `e2e/test.ocd` fixture, in paper mm. */
const CALIBRATION: MapCalibrationPoint[] = [
  { mapX: -76.4, mapY: -48.4, lat: 58.6, lng: 16.9 },
  { mapX: 76.4, mapY: -48.4, lat: 58.6, lng: 17.0 },
  { mapX: -76.4, mapY: 46.4, lat: 58.7, lng: 16.9 },
  { mapX: 76.4, mapY: 46.4, lat: 58.7, lng: 17.0 },
];

describe("sameMapFile", () => {
  it("ignores case", () => {
    expect(sameMapFile("Brotorp.ocd", "brotorp.OCD")).toBe(true);
  });

  it("accepts a converted file with the same stem", () => {
    expect(sameMapFile("Brotorp.omap", "Brotorp.ocd")).toBe(true);
  });

  it("rejects different maps and empty names", () => {
    expect(sameMapFile("Brotorp.ocd", "Nackareservatet.ocd")).toBe(false);
    expect(sameMapFile("", "Brotorp.ocd")).toBe(false);
  });
});

describe("positionsOffMap", () => {
  it("passes controls inside the map", () => {
    const controls = [
      { mapX: -30, mapY: -20 },
      { mapX: 0, mapY: 0 },
      { mapX: 40, mapY: 30 },
    ];
    expect(positionsOffMap(controls, CALIBRATION)).toBe(false);
  });

  it("tolerates a control just off the printed edge", () => {
    const controls = [
      { mapX: 70, mapY: 40 },
      { mapX: 80, mapY: 48 },
    ];
    expect(positionsOffMap(controls, CALIBRATION)).toBe(false);
  });

  it("flags a cluster that sits kilometres away", () => {
    // What a Purple Pen file set on another map looks like: every
    // control shifted by that map's georeference offset.
    const controls = [
      { mapX: -196, mapY: -41 },
      { mapX: -182, mapY: -16 },
    ];
    expect(positionsOffMap(controls, CALIBRATION)).toBe(true);
  });

  it("says nothing when there is nothing to judge", () => {
    expect(positionsOffMap([{ mapX: 0, mapY: 0 }], CALIBRATION)).toBe(false);
    expect(positionsOffMap([{ mapX: -900, mapY: 0 }], [])).toBe(false);
  });
});

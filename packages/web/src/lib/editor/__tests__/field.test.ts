import { describe, expect, it } from "vitest";
import { mapGeo } from "@oxygen/shared";
import {
  bearingDeg, detentHeights, distanceM, fieldRows, fixToPaper, initialModeFor, bandCentreOffsetPx, metreStepMm, nearestDetent, nudge,
  NUDGE_FINE_MM, type DetentHeights,
} from "../field";

/** Nackareservatet origin (SWEREF99 TM), OCAD units, 1:15 000 — as `projection.test.ts`. */
const nacka: mapGeo.PaperFrame = {
  unitsPerMm: 100,
  mapScale: 15000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 687000, y: 6574000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
};

describe("fixToPaper (docs/course-editor.md §9: the fix through mapGeo)", () => {
  it("puts a fix on paper where mapGeo puts it, and back", () => {
    const at = mapGeo.paperToWgs84(nacka, 12_000, -3_400)!;
    const p = fixToPaper(nacka, { lat: at.lat, lng: at.lng, accuracy: 5 })!;
    expect(p.x).toBeCloseTo(120, 6);
    expect(p.y).toBeCloseTo(-34, 6);
    expect(p.accuracyMm).toBeCloseTo((5 * 1000) / 15000, 9);
  });

  it("is null without a frame", () => {
    expect(fixToPaper(null, { lat: 59, lng: 18, accuracy: 3 })).toBeNull();
  });
});

describe("distance and bearing from the fix (§9)", () => {
  it("metres on the ground at the map scale", () => {
    expect(distanceM({ x: 0, y: 0 }, { x: 3, y: 4 }, 10000)).toBe(50);
    expect(distanceM({ x: 0, y: 0 }, { x: 3, y: 4 }, 15000)).toBe(75);
  });

  it("bearing from paper north, clockwise, 0–359", () => {
    expect(bearingDeg({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(0);
    expect(bearingDeg({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(90);
    expect(bearingDeg({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(180);
    expect(bearingDeg({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe(270);
    // Just west of north wraps to 359, never 360.
    expect(bearingDeg({ x: 0, y: 0 }, { x: -0.001, y: 10 })).toBe(0);
    expect(bearingDeg({ x: 0, y: 0 }, { x: -0.2, y: 10 })).toBe(359);
  });

  it("the course's rows in course order, blank without a fix", () => {
    const rows = [
      { id: 1, code: "S1", kind: "start" as const, pt: { x: 0, y: 0 } },
      { id: 31, code: "31", kind: "control" as const, pt: { x: 0, y: 10 } },
      { id: 32, code: "32", kind: "control" as const, pt: null },
    ];
    const withFix = fieldRows(rows, { x: 0, y: 0 }, 10000, new Set([31]));
    expect(withFix.map((r) => [r.id, r.distanceM, r.bearingDeg, r.checked])).toEqual([
      [1, 0, 0, false],
      [31, 100, 0, true],
      [32, null, null, false],
    ]);
    expect(fieldRows(rows, null, 10000, new Set()).every((r) => r.distanceM === null && r.bearingDeg === null)).toBe(true);
  });
});

describe("nudge pad (§9 \"Precision\")", () => {
  it("one metre on the ground in paper mm", () => {
    expect(metreStepMm(10000)).toBeCloseTo(0.1, 12);
    expect(metreStepMm(15000)).toBeCloseTo(1 / 15, 12);
  });

  it("moves along paper axes, y up", () => {
    const p = { x: 10, y: 20 };
    expect(nudge(p, "up", NUDGE_FINE_MM)).toEqual({ x: 10, y: 20.1 });
    expect(nudge(p, "down", NUDGE_FINE_MM)).toEqual({ x: 10, y: 19.9 });
    expect(nudge(p, "right", metreStepMm(10000)).x).toBeCloseTo(10.1, 12);
    // Rounded to the µm (a stored position needs no more).
    expect(nudge(p, "left", metreStepMm(15000)).x).toBe(9.933);
  });
});

describe("bottom sheet detents (§10)", () => {
  const h: DetentHeights = detentHeights(800);

  it("peek, half and full from the panel height", () => {
    expect(h.peek).toBe(120);
    expect(h.half).toBe(360);
    expect(h.full).toBe(744);
    // A short panel never inverts the order.
    const short = detentHeights(200);
    expect(short.peek).toBeLessThanOrEqual(short.half);
    expect(short.half).toBeLessThanOrEqual(short.full);
  });

  it("a released drag snaps to the nearest detent", () => {
    expect(nearestDetent(100, h)).toBe("peek");
    expect(nearestDetent(300, h)).toBe("half");
    expect(nearestDetent(600, h)).toBe("full");
  });

  it("centres the selection in the band above the sheet", () => {
    expect(bandCentreOffsetPx(360)).toEqual({ x: 0, y: -180 });
    expect(bandCentreOffsetPx(0)).toEqual({ x: 0, y: 0 });
  });
});

describe("initial mode (§1, §10)", () => {
  it("Field on a phone, Course otherwise", () => {
    expect(initialModeFor({ phone: true })).toBe("field");
    expect(initialModeFor({ phone: false })).toBe("course");
  });
});

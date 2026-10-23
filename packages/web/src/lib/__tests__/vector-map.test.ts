import { describe, it, expect } from "vitest";
import type { mapDocument } from "@oxygen/shared";
import { CLUB_BUDGET_BYTES, EVENT_BUDGET_BYTES } from "../../map-gl/buckets";
import { boundsMm, budgetBytes, documentColours, documentProxyColours, paperFrameOf } from "../vector-map";

const header = {
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 1, y: 2 }, gridRotationDeg: 2, gridScaleFactor: 1 },
  bounds: { minX: -10000, minY: 500, maxX: 30000, maxY: 20500 },
  colours: [
    { id: "a", name: "Black", cmyk: [0, 0, 0, 1] },
    { id: "b", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] },
    { id: "c", name: "White", cmyk: [0, 0, 0, 0] },
  ],
} as unknown as mapDocument.MapDocumentHeader;

describe("vector map header helpers", () => {
  it("builds the paper frame mapGeo reads, with the rotation correction", () => {
    expect(paperFrameOf(header, 1.5)).toEqual({ unitsPerMm: 100, mapScale: 10000, georeferencing: header.georeferencing, correctionDeg: 1.5 });
    expect(paperFrameOf(header, null).correctionDeg).toBe(0);
  });

  it("converts bounds to paper mm", () => {
    expect(boundsMm(header)).toEqual({ minX: -100, minY: 5, maxX: 300, maxY: 205 });
  });

  it("colours stack positions from CMYK, magenta when out of range", () => {
    const c = documentColours(header.colours);
    expect(c(0)).toEqual([0, 0, 0]);
    expect(c(2)).toEqual([1, 1, 1]);
    expect(c(9)).toEqual([1, 0, 1]);
  });

  it("picks the darkest colour for lines and the lightest non-white for areas", () => {
    expect(documentProxyColours(header.colours)).toEqual({ line: 0, area: 1, point: 0, text: 0 });
    expect(documentProxyColours([])).toEqual({ line: 0, area: 0, point: 0, text: 0 });
  });

  it("budgets by provenance", () => {
    expect(budgetBytes("event")).toBe(EVENT_BUDGET_BYTES);
    expect(budgetBytes("club")).toBe(CLUB_BUDGET_BYTES);
  });
});

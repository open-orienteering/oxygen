import { describe, expect, it } from "vitest";
import type { MapDocument } from "../../map-document/index.js";
import { S, line, mapped, ring, syntheticDoc } from "../graph/__tests__/synthetic.js";
import { tick } from "../solve/__tests__/fixtures.js";
import { HEIGHT_NO_DATA, decodeHeightField, encodeHeightField, sampleHeight } from "../field/index.js";
import { contourIntervalM, deriveTerrain } from "../index.js";

// A hill of four rings around (30, 30) with a slope tick on the outer ring pointing out (downhill).
const HILL = mapped([...[5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) })), tick(50, 30, 1, 0)]);
const withLibrary = (d: MapDocument, id: string): MapDocument => ({ ...d, header: { ...d.header, library: d.header.library && { ...d.header.library, id } } });

describe("deriveTerrain (map-terrain.md §5.5)", () => {
  it("derives a hill from the document alone: graph, solve, field", () => {
    const t = deriveTerrain(syntheticDoc(HILL));
    if (!t) throw new Error("no terrain");
    expect(t.report.share.decided).toBeGreaterThan(0.99);
    const m = (x: number, y: number) => sampleHeight(t.field, { x, y })! / t.field.header.intervalM;
    expect(m(30, 30)).toBeGreaterThan(4.3);
    expect(Math.abs(m(30 + 12.5, 30) - 2.5)).toBeLessThan(0.1);
    expect(m(30, 30 - 17.5)).toBeCloseTo(1.5, 1);
    expect(t.field.header).toMatchObject({ intervalM: 5, cellMm: expect.closeTo(0.2, 12), datum: "relative", source: "contours" });
    expect(t.field.z.some((v) => v === HEIGHT_NO_DATA)).toBe(false); // the mapped area covers the raster
  });

  it("is null without contours", () => {
    expect(deriveTerrain(syntheticDoc(mapped([], [0, 0, 10, 10])))).toBeNull();
  });

  it("counts in 2.5 m on a sprint map and 5 m otherwise", () => {
    const d = syntheticDoc(HILL);
    expect(contourIntervalM(d.header)).toBe(5);
    expect(contourIntervalM(withLibrary(d, "ISSprOM2019-2").header)).toBe(2.5);
    expect(contourIntervalM({ library: null })).toBe(5);
    expect(deriveTerrain(withLibrary(d, "ISSprOM2019-2"))!.field.header.intervalM).toBe(2.5);
    expect(deriveTerrain(d, { intervalM: 2 })!.field.header.intervalM).toBe(2);
  });

  it("grows the field cell to stay within the budget", () => {
    const t = deriveTerrain(syntheticDoc(HILL), { field: { maxCells: 20_000 } })!;
    expect(t.field.header.width * t.field.header.height).toBeLessThanOrEqual(20_000);
    expect(t.field.header.cellMm).toBeGreaterThan(0.2);
  });

  it("passes the solve's options through", () => {
    // a slope of open contours whose only evidence is the tick: without it the chains stay undecided
    const slope = mapped([...[10, 20, 30].map((y) => ({ sym: S.contour, coords: line(0, y, 60, y) })), tick(30, 20, 0, -1)], [0, 5, 60, 35]);
    const d = syntheticDoc(slope);
    expect(deriveTerrain(d)!.report.share.decided).toBeGreaterThan(0.9);
    const none = deriveTerrain(d, { solve: { evidence: { tick: [], cliff: [], lake: [], top: [], formTick: [] }, heuristics: false } })!;
    expect(none.report.share.decided).toBe(0);
  });

  it("is deterministic to the byte", () => {
    expect(encodeHeightField(deriveTerrain(syntheticDoc(HILL))!.field)).toEqual(encodeHeightField(decodeHeightField(encodeHeightField(deriveTerrain(syntheticDoc(HILL))!.field))));
  });
});

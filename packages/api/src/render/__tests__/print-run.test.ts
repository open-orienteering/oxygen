/**
 * The corpus print run's pure parts (docs/course-print.md §11): the sheet
 * from the OCAD print window, the synthetic course, the page's sanctioned
 * codes and the previous-run comparison. The run itself is covered by
 * `scripts/__tests__/measure-print.test.mjs` on `e2e/test.ocd`.
 */

import { describe, expect, it } from "vitest";
import { type PrintRunReport, comparePrevious, pageSanctionedCodes, parityFailures, printSheetFor, syntheticCourse } from "../print-run.js";
import { resolveSheet } from "../../course-maps/resolve-sheet.js";

const header = (printWindow: { scale?: number; left: number; bottom: number; right: number; top: number } | null, mapScale = 15000) => ({
  mapScale,
  unitsPerMm: 100,
  bounds: { minX: -50_000, minY: -20_000, maxX: 30_000, maxY: 40_000 },
  printWindow,
});

const frameOf = (spec: ReturnType<typeof printSheetFor>) => (spec.template.settings as { mapFrame: { x: number; y: number; width: number; height: number } }).mapFrame;

describe("printSheetFor", () => {
  it("prints the OCAD print window at its scale on a sheet of frame + margins", () => {
    // 140 × 99 mm of a 1:15 000 map printed at 1:5 000 → a 420 × 297 mm frame.
    const spec = printSheetFor(header({ scale: 5000, left: 10, bottom: -20, right: 150, top: 79 }));
    expect(spec.source).toBe("print-window");
    expect(spec.printScale).toBe(5000);
    expect(spec.centre).toEqual({ x: 80, y: 29.5 });
    expect(spec.template).toMatchObject({ paper: "custom", orientation: "landscape", paperWidthMm: 426, paperHeightMm: 303 });
    expect(frameOf(spec)).toEqual({ x: 3, y: 3, width: 420, height: 297 });
    const { layout } = resolveSheet({ kind: "all_controls", template: spec.template, windowCenter: spec.centre, mapScale: spec.mapScale });
    expect(layout.window).toMatchObject({ minX: 10, minY: -20, width: 140, height: 99 });
  });

  it("rounds a fractional sheet up to whole mm", () => {
    const spec = printSheetFor(header({ scale: 4000, left: -50.1, bottom: 0, right: 49.6, top: 42.3 }, 4000));
    expect(spec.template).toMatchObject({ paperWidthMm: 106, paperHeightMm: 49 });
    expect(frameOf(spec)).toEqual({ x: 3, y: 3, width: 100, height: 43 });
  });

  it("uses the map scale when the print window has none, portrait for a tall window", () => {
    const spec = printSheetFor(header({ left: 0, bottom: 0, right: 40, top: 60 }, 10000));
    expect(spec.printScale).toBe(10000);
    expect(spec.template).toMatchObject({ paper: "custom", orientation: "portrait", paperWidthMm: 46, paperHeightMm: 66 });
  });

  it("falls back to A4 at the map scale on the bounds' centre without a print window", () => {
    const spec = printSheetFor(header(null, 7500));
    expect(spec.source).toBe("bounds");
    expect(spec.centre).toEqual({ x: -100, y: 100 });
    expect(spec.printScale).toBe(7500);
    // The bounds are 800 × 600 mm: wider than tall.
    expect(spec.template).toMatchObject({ paper: "A4", orientation: "landscape", paperWidthMm: null });
    expect(frameOf(spec)).toEqual({ x: 3, y: 3, width: 291, height: 204 });
  });

  it("takes paper, scale and centre overrides", () => {
    const spec = printSheetFor(header({ scale: 15000, left: 0, bottom: 0, right: 420, top: 297 }), { paper: { size: "A4" }, printScale: 10000, centre: { x: 5, y: 6 } });
    expect(spec.source).toBe("override");
    expect(spec.printScale).toBe(10000);
    expect(spec.centre).toEqual({ x: 5, y: 6 });
    // Orientation follows the print window when not given.
    expect(spec.template).toMatchObject({ paper: "A4", orientation: "landscape" });
    expect(printSheetFor(header(null), { paper: { size: "A3", orientation: "portrait" } }).template).toMatchObject({ paper: "A3", orientation: "portrait" });
  });

  it("shows the description block only on a frame with room for it", () => {
    const big = (printSheetFor(header(null)).template.settings as { description: { visible: boolean; x: number } }).description;
    expect(big).toMatchObject({ visible: true, x: 3 + 291 - 40 - 2 });
    const small = printSheetFor(header({ left: 0, bottom: 0, right: 40, top: 60 }, 15000));
    expect((small.template.settings as { description: { visible: boolean } }).description.visible).toBe(false);
  });
});

describe("syntheticCourse", () => {
  it("places start, four controls and finish inside the window, deterministically", () => {
    const c = syntheticCourse({ x: 100, y: -50 }, { width: 140, height: 99 }, 15000);
    expect(c).toEqual(syntheticCourse({ x: 100, y: -50 }, { width: 140, height: 99 }, 15000));
    expect(c.controls.map((x) => x.codes)).toEqual(["31", "32", "33", "34"]);
    const features = (c.geometry as { features: Array<{ properties: { symbolType: string }; geometry: { coordinates: number[] } }> }).features;
    expect(features.map((f) => f.properties.symbolType)).toEqual(["start", "finish"]);
    const pts = [...features.map((f) => ({ x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] })), ...c.controls.map((x) => ({ x: x.xpos, y: x.ypos }))];
    for (const p of pts) {
      expect(Math.abs(p.x - 100)).toBeLessThanOrEqual(0.3 * 140);
      expect(Math.abs(p.y + 50)).toBeLessThanOrEqual(0.3 * 99);
    }
    expect(c.lengthM % 10).toBe(0);
    expect(c.lengthM).toBeGreaterThan(0);
  });

  it("resolves to a course page with legs and a description block", () => {
    const spec = printSheetFor(header(null, 7500));
    const course = syntheticCourse(spec.centre, { width: 291, height: 204 }, 7500);
    const { layout, sheet } = resolveSheet({ kind: "course", template: spec.template, course, windowCenter: spec.centre, mapScale: 7500 });
    expect(layout.controls.map((c) => c.type)).toEqual(["start", "control", "control", "control", "control", "finish"]);
    expect(layout.legs).toHaveLength(5);
    expect(sheet.description?.rows.length).toBeGreaterThan(4);
  });
});

describe("pageSanctionedCodes", () => {
  it("names the §8.4 codes the page and mode trigger", () => {
    const rgb = pageSanctionedCodes({ mode: "rgb", description: false, rotated: false });
    expect(rgb).toEqual(["course-symbol-sizes", "library-symbols", "north-lines-below", "size-aware-cuts", "stack-order", "start-finish-clearance", "start-turned"]);
    const cmyk = pageSanctionedCodes({ mode: "cmyk", description: true, rotated: true });
    expect(cmyk).toEqual(expect.arrayContaining(["cmyk-colour", "description-weight", "description-font", "rotated-overprint"]));
    expect(cmyk).toEqual([...cmyk].sort());
  });
});

describe("parityFailures", () => {
  it("gates shape at 0.01 % of ink and shading at 0.5 % beyond 32 levels (§11.3)", () => {
    // Crop-A's measured page: 1.43 % beyond 16 levels is anti-aliasing, not a failure.
    expect(parityFailures("rgb", { strongRatio: 0.00133, shapeRatio: 0 })).toEqual([]);
    expect(parityFailures("rgb", { strongRatio: 0.006, shapeRatio: 0 })).toEqual([expect.stringMatching(/^rgb: 0\.600 % of the pixels beyond 32 levels/)]);
    expect(parityFailures("cmyk", { strongRatio: 0, shapeRatio: 0.0002 })).toEqual([expect.stringMatching(/^cmyk: unexplained 0\.0200 % of ink/)]);
  });
});

describe("comparePrevious", () => {
  const mode = (sha256: string, bytes: number, renderMs: number, ratio: number) => ({
    bytes, sha256, renderMs, pageMm: { width: 297, height: 210 }, qpdf: "ok" as const, parity: { differing: 0, total: 1, ratio }, outline: { differing: 0, total: 1, ratio: ratio / 2 }, strong: { differing: 0, ratio: 0 }, shape: { unexplained: 0, ink: 1, ratio: 0 }, warnings: 0, sanctioned: [],
  });
  const report = (rgb: string, legacy: number | null, diverging: number): Pick<PrintRunReport, "modes" | "legacy" | "symbols"> => ({
    modes: { rgb: mode(rgb, 1000, 100, 0.001), cmyk: mode("c", 1200, 120, 0.002) },
    legacy: legacy === null ? { skipped: "--no-legacy" } : { pageMm: { width: 297, height: 210 }, convertMs: 1, bytes: 1, differing: 0, ink: 1, unexplained: 0, inkRatio: 0, unexplainedRatio: legacy, legacyTiltDeg: 0 },
    symbols: { window: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, compared: 3, diverging: Array.from({ length: diverging }, () => ({ code: "1", name: "", kind: "line", unexplainedRatio: 0.2, sanctioned: [] })), unsanctioned: 0 },
  });

  it("is null without a previous report", () => {
    expect(comparePrevious(report("a", 0.1, 1), null)).toBeNull();
  });

  it("reports equal bytes per mode and the deltas", () => {
    const prev = { ...report("b", 0.05, 3), modes: { rgb: mode("b", 900, 150, 0.003), cmyk: mode("c", 1200, 120, 0.002) } } as PrintRunReport;
    const p = comparePrevious(report("a", 0.1, 1), prev)!;
    expect(p.sameBytes).toEqual({ rgb: false, cmyk: true });
    expect(p.bytesDelta).toEqual({ rgb: 100, cmyk: 0 });
    expect(p.renderMsDelta).toEqual({ rgb: -50, cmyk: 0 });
    expect(p.parityDelta.rgb).toBeCloseTo(-0.002);
    expect(p.outlineDelta.rgb).toBeCloseTo(-0.001);
    expect(p.legacyUnexplainedDelta).toBeCloseTo(0.05);
    expect(p.divergingDelta).toBe(-2);
    expect(comparePrevious(report("a", null, 1), prev)!.legacyUnexplainedDelta).toBeNull();
  });
});

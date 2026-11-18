/**
 * The page layer on its own (docs/course-print.md §4.4, docs/course-layout.md
 * §1): what `composePage` draws after the map layer, and the same stream in
 * paper µm for the editor's page view.
 */

import { describe, expect, it } from "vitest";
import { composePage } from "../../print/compose.js";
import { pageScene } from "../../print/__fixtures__/pages.js";
import { mapLayerTransform, pagePointToMap } from "../../print/page.js";
import { liberation } from "../../render/__tests__/fonts.js";
import type { TextPass } from "../../render/pass-stream.js";
import type { CourseMapObject } from "../../course-maps/schema.js";
import { courseLayer } from "../layer.js";
import { mapLayerWindow, pageLayer, pageStreamInMap } from "../page-layer.js";

const fonts = () => [liberation().sans, liberation().narrow];

function layerColours(name: "page-sprint-a4" | "page-ring") {
  const input = pageScene(name);
  // The composer's map-layer input: the window is what draws a toner saver (and adds its white row, P1).
  const layer = courseLayer({ ...input.course, objects: input.course.objects ?? [], document: input.map.context, viewOptions: { ...input.course.viewOptions, window: mapLayerWindow(input) } });
  return { input, colours: layer.colours };
}

describe("pageLayer", () => {
  for (const name of ["page-sprint-a4", "page-ring"] as const) {
    it(`is the composer's page layer (${name}): same stream, same colour table`, () => {
      const { input, colours } = layerColours(name);
      const page = composePage(input, fonts());
      const layer = pageLayer({ ...input, context: input.map.context }, colours, fonts());
      expect(layer.stream.passes.length).toBe(page.pageLayer.stream.passes.length);
      expect(layer.stream).toEqual(page.pageLayer.stream);
      expect(layer.colours).toEqual(page.colours);
      expect(layer.transform).toEqual(page.mapLayer.transform);
      expect(layer.images).toEqual(page.images.filter((i) => i.layer === "page"));
    });
  }

  it("draws the sheet's layout objects and the block only: neither, an empty stream (the toner saver is the map layer's)", () => {
    const { input, colours } = layerColours("page-ring");
    const layer = pageLayer({ ...input, objects: [], context: input.map.context }, colours, fonts());
    expect(layer.stream.passes).toEqual([]);
  });
});

describe("pageLayer: opacity, blend, rotation (J4)", () => {
  const draw = (objects: CourseMapObject[]) => {
    const { input, colours } = layerColours("page-ring");
    return pageLayer({ ...input, objects, context: input.map.context }, colours, fonts());
  };
  const H = 90; // page-ring's paper height, mm
  const rect = (extra: Partial<Extract<CourseMapObject, { kind: "rectangle" }>> = {}): CourseMapObject =>
    ({ id: "r", anchor: "page", kind: "rectangle", x: 10, y: 10, width: 20, height: 10, fillMode: "solid", fill: "#1f6fb2", stroke: "#000000", strokeWidthMm: 0.4, ...extra });
  const bbox = (c: Int32Array) => {
    const xs = [...c].filter((_, i) => i % 2 === 0), ys = [...c].filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  it("a filled and stroked shape at 50 % puts the opacity on both its fill and its stroke pass; Multiply likewise", () => {
    const passes = draw([rect({ opacity: 0.5, blend: "multiply" })]).stream.passes;
    expect(passes.map((p) => p.kind)).toEqual(["fill", "stroke"]);
    for (const p of passes) expect(p).toMatchObject({ opacity: 0.5, blend: "multiply" });
  });

  it("objects without the fields, or at opacity 1, give today's stream", () => {
    const plain = draw([rect()]).stream;
    expect(draw([rect({ opacity: 1, rotationDeg: 0 })]).stream).toEqual(plain);
    for (const p of plain.passes) expect("opacity" in p || "blend" in p).toBe(false);
  });

  it("a rectangle turned 90° is its turned corners about the box centre, in every fill mode", () => {
    // Stored y-down: box 10..30 × 10..20, centre (20, 15). Turned 90°: 15..25 × 5..25; y-up page µm: y = H − y.
    for (const fillMode of ["solid", "whiteout", "outOfBounds"] as const) {
      const fill = draw([rect({ rotationDeg: 90, fillMode })]).stream.passes.find((p) => p.kind === "fill" || p.kind === "hatch")!;
      expect("path" in fill).toBe(true);
      if (!("path" in fill)) continue;
      expect(bbox(fill.path.coords), fillMode).toEqual([15000, (H - 25) * 1000, 25000, (H - 5) * 1000]);
    }
    // A 709 hatch stays upright: the turned path carries no object angle.
    const hatch = draw([rect({ rotationDeg: 30, fillMode: "outOfBounds" })]).stream.passes.find((p) => p.kind === "hatch");
    const upright = draw([rect({ fillMode: "outOfBounds" })]).stream.passes.find((p) => p.kind === "hatch");
    expect(hatch && upright && hatch.angleDeg).toBe(upright?.angleDeg);
  });

  it("a page text turned 30° clockwise gets glyph angles of −30 (counter-clockwise in y-up)", () => {
    const text = draw([{ id: "t", anchor: "page", kind: "text", x: 20, y: 40, text: "Lucka", fontSizeMm: 4, color: "#000000", rotationDeg: 30, opacity: 0.5 }]).stream.passes.find((p) => p.kind === "text") as TextPass;
    expect(text.opacity).toBe(0.5);
    expect([...text.angles!].every((a) => Math.abs(a + 30) < 1e-4)).toBe(true);
  });
});

describe("pageStreamInMap", () => {
  it("puts a page text where T_map⁻¹ puts its page position (paper µm)", () => {
    const { input, colours } = layerColours("page-ring");
    const layer = pageLayer({ ...input, context: input.map.context }, colours, fonts());
    const inMap = pageStreamInMap(layer);
    expect(inMap.passes.length).toBe(layer.stream.passes.length);
    const texts = layer.stream.passes.flatMap((p, i) => (p.kind === "text" ? [i] : []));
    expect(texts.length).toBeGreaterThan(0);
    const t = mapLayerTransform(input.frame, input.window, input.paper.heightMm);
    for (const i of texts) {
      const page = layer.stream.passes[i] as TextPass, map = inMap.passes[i] as TextPass;
      const [ex, ey] = pagePointToMap(t, page.positions[0], page.positions[1]);
      expect(map.positions[0]).toBeCloseTo(ex, 0);
      expect(map.positions[1]).toBeCloseTo(ey, 0);
      expect(map.sizeUm).toBeCloseTo(page.sizeUm / t.scaleRatio, 3);
    }
  });

  it("scales stroke widths by 1 / scaleRatio (a 1:4 000 map printed at 1:3 000)", () => {
    const { input, colours } = layerColours("page-sprint-a4");
    const layer = pageLayer({ ...input, context: input.map.context }, colours, fonts());
    const inMap = pageStreamInMap(layer);
    const i = layer.stream.passes.findIndex((p) => p.kind === "stroke");
    expect(i).toBeGreaterThanOrEqual(0);
    const a = layer.stream.passes[i], b = inMap.passes[i];
    if (a.kind !== "stroke" || b.kind !== "stroke") throw new Error("stroke expected");
    expect(b.widthUm).toBeCloseTo(a.widthUm * (3000 / 4000), 6);
  });
});

/** `courseLayer()` through `symbolise` with a document (course-layer.md §1, §3). */

import { describe, expect, it } from "vitest";
import { courseLayer, courseRenderInput } from "../layer.js";
import { courseDocumentContext } from "../context.js";
import { layerInput, linear, site, sprintContext } from "./helpers.js";
import { materialiseLibrary } from "../../symbol-library/index.js";
import { symbolise } from "../../render/symbolise.js";
import { makePath } from "../../render/pass-stream.js";
import { liberation } from "../../render/__tests__/fonts.js";
import type { RenderObject } from "../../render/symbolise.js";
import type { CourseMapObject } from "../../course-maps/schema.js";

/** A tiny ISOM "document": a 516 power line (black) across the first leg, resolved on the palette stack. */
function isomDocument(): { objects: RenderObject[]; symbols: ReturnType<typeof materialiseLibrary>["symbols"] } {
  const lib = materialiseLibrary("ISOM2017-2");
  const i = lib.library.entries.findIndex((e) => e.id === "ISOM2017-2:516");
  return { symbols: [lib.symbols[i]], objects: [{ symbolIdx: 0, path: makePath([25000, 0, 25000, 20000]) }] };
}

const fonts = () => [liberation().sans];
const colourId = (layer: ReturnType<typeof courseLayer>, i: number) => layer.colours[i].paletteIds?.[0] ?? layer.colours[i].id;

describe("courseLayer + courseRenderInput → one symbolise call", () => {
  it("draws warning-free, lower purple under black, numbers lower purple (ISOM spec)", () => {
    const layer = courseLayer(layerInput());
    const input = courseRenderInput(isomDocument(), layer);
    const { stream, warnings } = symbolise({ ...input, fonts: fonts() });
    expect(warnings).toEqual([]);
    expect(layer.warnings).toEqual([]);
    const colours = stream.passes.map((p) => colourId(layer, p.colour));
    // The document's black was re-indexed onto the completed stack.
    expect(colours).toContain("black100");
    const lastLower = colours.lastIndexOf("purple-lower");
    expect(lastLower).toBeLessThan(colours.indexOf("black100"));
    const text = stream.passes.filter((p) => p.kind === "text");
    expect(text).toHaveLength(3);
    expect(text.every((p) => colourId(layer, p.colour) === "purple-lower")).toBe(true);
    for (const p of stream.passes) expect(p.colour).toBeLessThan(layer.colours.length);
    // Course objects follow the document's: pass objectIdx ≥ the offset for course symbols.
    stream.passes.forEach((p, k) => {
      if (input.symbols[stream.symbolIdx[k]].id.startsWith("ISOM2017-2:516")) expect(stream.objectIdx[k]).toBe(0);
      else expect(stream.objectIdx[k]).toBeGreaterThanOrEqual(input.courseObjectOffset);
    });
  });

  it("emits a turned start, gapped circles as open arcs, one stroke per leg piece", () => {
    const layer = courseLayer(layerInput({ cutFeatures: [{ x: 42.5, y: 10 }] }));
    const start = layer.objects.find((o) => o.ref.kind === "site" && o.ref.id === "S")!;
    expect(start.angleDeg).toBeCloseTo(-90, 9);
    const arcs = layer.objects.filter((o) => o.ref.kind === "site" && o.ref.id === "31");
    expect(arcs).toHaveLength(1);
    expect(arcs[0].path.closed).toBe(false);
    expect(layer.objects.filter((o) => o.ref.kind === "site" && o.ref.id === "32")[0].path.closed).toBe(true);
    expect(layer.objects.filter((o) => o.ref.kind === "leg")).toHaveLength(4);
  });

  it("knockout numbers: an upper-white halo pass below the upper-purple text", () => {
    const layer = courseLayer(layerInput({ appearance: { numberStyle: "knockout" } }));
    const { stream } = symbolise({ ...courseRenderInput(isomDocument(), layer), fonts: fonts() });
    const text = stream.passes.map((p, k) => ({ p, k })).filter(({ p }) => p.kind === "text");
    const halo = text.filter(({ p }) => p.kind === "text" && p.haloWidthUm);
    expect(halo.map(({ p }) => colourId(layer, p.colour))).toEqual(["white-upper", "white-upper", "white-upper"]);
    expect(Math.max(...halo.map(({ k }) => k))).toBeLessThan(Math.min(...text.filter(({ p }) => p.kind === "text" && !p.haloWidthUm).map(({ k }) => k)));
  });

  it("sprint documents: 6 mm circles, numbers upper purple, stack unchanged", () => {
    const layer = courseLayer(layerInput({ document: sprintContext() }));
    expect(layer.remap).toBeNull();
    const circle = layer.objects.find((o) => o.ref.kind === "site" && o.ref.id === "32")!;
    expect(Math.max(...Array.from(circle.path.coords).filter((_, i) => i % 2 === 1))).toBe(40000 + 3000);
    const number = layer.symbols[layer.objects.find((o) => o.ref.kind === "number")!.symbolIdx];
    expect(number.type === "text" && colourId(layer, number.colour)).toBe("purple-upper");
  });
});

describe("layout objects (§3.6)", () => {
  const rect = (fillMode: "whiteout" | "whiteoutInverted" | "outOfBounds" | "solid", extra: Record<string, unknown> = {}): CourseMapObject =>
    ({ id: `r-${fillMode}`, anchor: "map", kind: "rectangle", x: 20, y: 20, width: 10, height: 5, fillMode, ...extra }) as CourseMapObject;

  it("white-out at upper white, 709 hatch, own-colour rows on top, page objects ignored", () => {
    const objects: CourseMapObject[] = [
      rect("whiteout"),
      rect("outOfBounds", { stroke: "#000000", strokeWidthMm: 0.3 }),
      rect("solid", { fill: "#ff0000" }),
      { id: "t", anchor: "map", kind: "text", x: 5, y: 5, text: "{course}", fontSizeMm: 3, color: "#0000ff" },
      { id: "l", anchor: "map", kind: "line", x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#0000ff", strokeWidthMm: 0.5, dash: "dashed" },
      { id: "p", anchor: "page", kind: "text", x: 5, y: 5, text: "page", fontSizeMm: 3, color: "#000000" },
    ];
    const layer = courseLayer(layerInput({ objects, viewOptions: { textValues: { course: "Lång" }, overprintScale: 1.5 } }));
    const byRef = (id: string) => layer.objects.filter((o) => o.ref.kind === "object" && o.ref.id === id);
    const sym = (id: string) => layer.symbols[byRef(id)[0].symbolIdx];
    expect(sym("r-whiteout")).toMatchObject({ type: "area", fill: layer.colours.findIndex((c) => c.paletteIds?.includes("white-upper")) });
    expect(sym("r-outOfBounds").id).toBe("ISOM2017-2:709.b");
    expect(byRef("r-outOfBounds")).toHaveLength(1);
    const top = layer.colours.slice(-2).map((c) => c.id);
    expect(top).toEqual(["course-object:#ff0000", "course-object:#0000ff"]);
    expect(byRef("t")[0].text).toBe("Lång");
    // Page mm sizes divided by the print enlargement.
    expect(sym("t")).toMatchObject({ type: "text", fontSizeUm: 2000 });
    expect(sym("l")).toMatchObject({ type: "line", main: { widthUm: 333, dash: { dashUm: 1667, gapUm: 833 } } });
    expect(byRef("p")).toEqual([]);
  });

  it("white-out outside: the window ring with the shape as a hole; warned without a window", () => {
    const window = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const layer = courseLayer(layerInput({ objects: [rect("whiteoutInverted")], viewOptions: { window } }));
    const ring = layer.objects.find((o) => o.ref.kind === "object")!;
    expect(ring.path.coords.length).toBe(16);
    expect(ring.path.flags[4] & 16).toBe(16);
    const missing = courseLayer(layerInput({ objects: [rect("whiteoutInverted")] }));
    expect(missing.objects.filter((o) => o.ref.kind === "object")).toEqual([]);
    expect(missing.warnings.map((w) => w.code)).toEqual(["WINDOW_MISSING"]);
  });

  it("images are returned for the page backends, not as objects", () => {
    const layer = courseLayer(layerInput({ objects: [{ id: "img", anchor: "map", kind: "image", graphicId: 3, x: 1, y: 2, width: 3, height: 4 }] }));
    expect(layer.images).toEqual([expect.objectContaining({ rectUm: { x: 1000, y: 2000, width: 3000, height: 4000 } })]);
    expect(layer.objects.some((o) => o.ref.kind === "object")).toBe(false);
  });
});

describe("courseDocumentContext", () => {
  const colours = layerInput().document.colours;
  it("reads the matched library and factor; unmatched documents choose by scale", () => {
    expect(courseDocumentContext({ colours, library: { id: "ISOM2017-2", version: "x" }, documentFactor: 1.5, mapScale: 10000 })).toMatchObject({ libraryId: "ISOM2017-2", documentFactor: 1.5 });
    expect(courseDocumentContext({ colours, library: null, documentFactor: 1, mapScale: 10000 })).toMatchObject({ libraryId: "ISOM2017-2", documentFactor: 1.5 });
    expect(courseDocumentContext({ colours, library: null, documentFactor: 1, mapScale: 4000 })).toMatchObject({ libraryId: "ISSprOM2019-2", documentFactor: 1 });
  });

  it("a site at the origin is not drawn", () => {
    const layer = courseLayer(layerInput({ sites: [site("31", "control", 0, 0)], structure: linear(["31"]) }));
    expect(layer.objects).toEqual([]);
  });
});

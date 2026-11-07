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
import type { CourseLayerObject } from "../objects.js";

/** A tiny ISOM "document": a 516 power line (black) across the first leg, resolved on the palette stack. */
function isomDocument(): { objects: RenderObject[]; symbols: ReturnType<typeof materialiseLibrary>["symbols"] } {
  const lib = materialiseLibrary("ISOM2017-2");
  const i = lib.library.entries.findIndex((e) => e.id === "ISOM2017-2:516");
  return { symbols: [lib.symbols[i]], objects: [{ symbolIdx: 0, path: makePath([25000, 0, 25000, 20000]) }] };
}

const fonts = () => [liberation().sans];
const colourId = (layer: ReturnType<typeof courseLayer>, i: number) => layer.colours[i].paletteIds?.[0] ?? layer.colours[i].id;

describe("courseLayer + courseRenderInput → one symbolise call", () => {
  it("draws warning-free, lower purple under black, numbers upper purple (ISOM, user decision 2026-10-24)", () => {
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
    expect(text.every((p) => colourId(layer, p.colour) === "purple-upper")).toBe(true);
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

  it("auto cuts off: the same objects as without cut features (one rule for the layer and the artifact)", () => {
    const off = courseLayer(layerInput({ cutFeatures: [{ x: 42.5, y: 10 }, { x: 25, y: 10.2 }], viewOptions: { autoCuts: false } }));
    const none = courseLayer(layerInput({ viewOptions: { autoCuts: false } }));
    expect(off.objects).toEqual(none.objects);
    expect(off.objects.filter((o) => o.ref.kind === "site" && o.ref.id === "31")[0].path.closed).toBe(true);
    const on = courseLayer(layerInput({ cutFeatures: [{ x: 42.5, y: 10 }, { x: 25, y: 10.2 }] }));
    expect(on.objects).not.toEqual(off.objects);
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

describe("leg styles (§10.1, F1)", () => {
  const styled = () =>
    courseLayer(layerInput({
      structure: linear(undefined, {
        items: [{ siteId: "S" }, { siteId: "31", leg: { style: "marked_route", bends: [{ x: 25, y: 20 }] } }, { siteId: "32", leg: { style: "none" } }, { siteId: "33" }],
      }),
    }));

  it("a marked route draws 707 through its bends: upper purple, dashed, over black", () => {
    const layer = styled();
    const route = layer.objects.filter((o) => o.ref.kind === "leg" && o.ref.id === "c1:0");
    expect(route).toHaveLength(1);
    expect(layer.symbols[route[0].symbolIdx].id).toContain("707");
    // The bend is a vertex of the drawn path.
    const c = route[0].path.coords;
    expect([...c].some((v, i) => i % 2 === 0 && v === 25000 && c[i + 1] === 20000)).toBe(true);
    expect(layer.symbols[layer.objects.find((o) => o.ref.kind === "leg" && o.ref.id === "c1:2")!.symbolIdx].id).toContain("705");

    const input = courseRenderInput(isomDocument(), layer);
    const { stream } = symbolise({ ...input, fonts: fonts() });
    const routeIdx = layer.objects.indexOf(route[0]) + input.courseObjectOffset;
    const passes = stream.passes.map((p, k) => ({ p, k })).filter(({ k }) => stream.objectIdx[k] === routeIdx);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every(({ p }) => colourId(layer, p.colour) === "purple-upper")).toBe(true);
    const slices = passes.reduce((n, { p }) => n + (p.kind === "stroke" ? (p.slices?.length ?? 1) : 0), 0);
    expect(slices).toBeGreaterThan(3);
    const colours = stream.passes.map((p) => colourId(layer, p.colour));
    expect(Math.min(...passes.map(({ k }) => k))).toBeGreaterThan(colours.lastIndexOf("black100"));
  });

  it("a none leg draws nothing; its number and the others' are unchanged", () => {
    const layer = styled();
    expect(layer.objects.filter((o) => o.ref.kind === "leg" && o.ref.id === "c1:1")).toEqual([]);
    expect(layer.derivation.courses[0].legs[1].pieces.length).toBeGreaterThan(0);
    expect(layer.derivation.sites.find((s) => s.id === "32")!.label!.text).toBe("2");
    expect(layer.objects.filter((o) => o.ref.kind === "number").map((o) => o.text)).toEqual(["1", "2", "3"]);
  });
});

describe("filter regions (map-rendering §4.11)", () => {
  const square = [{ x: 20, y: -5 }, { x: 30, y: -5 }, { x: 30, y: 25 }, { x: 20, y: 25 }];
  const hole = [{ x: 24, y: 0 }, { x: 26, y: 0 }, { x: 26, y: 2 }];
  it("rings in mm become one closed µm path with hole flags; document colours move onto the completed stack", () => {
    const layer = courseLayer(layerInput({ regions: [{ rings: [square, hole], mode: "clip", symbols: { colours: [0, 20] }, invert: true }] }));
    expect(layer.remap).not.toBeNull();
    const [r] = layer.regions;
    expect(r.path.closed).toBe(true);
    expect(Array.from(r.path.coords.slice(0, 4))).toEqual([20000, -5000, 30000, -5000]);
    expect(Array.from(r.path.flags)).toEqual([0, 0, 0, 0, 16, 0, 0]);
    expect(r).toMatchObject({ mode: "clip", invert: true, symbols: { colours: [layer.remap![0], layer.remap![20]] } });
  });
  it("hide removes the document's 516 under the region but never the course over it", () => {
    const layer = courseLayer(layerInput({ regions: [{ rings: [square], mode: "hide", symbols: "all" }] }));
    const input = courseRenderInput(isomDocument(), layer);
    expect(input.regionObjectLimit).toBe(1);
    const plain = symbolise({ ...courseRenderInput(isomDocument(), courseLayer(layerInput())), fonts: fonts() });
    const { stream, hidden, warnings } = symbolise({ ...input, fonts: fonts() });
    expect(warnings).toEqual([]);
    expect(hidden).toEqual([0]);
    expect(stream.objectIdx.includes(0)).toBe(false);
    expect(stream.passes.length).toBe(plain.stream.passes.filter((_, k) => plain.stream.objectIdx[k] !== 0).length);
  });
  it("a stored filter_region course object (§8.3) acts exactly like the explicit region, after the explicit ones", () => {
    const stored: CourseLayerObject = { id: 4, kind: "filter_region", geometry: square, props: { mode: "hide", symbols: "all" } };
    const layer = courseLayer(layerInput({ objects: [stored] }));
    const explicit = courseLayer(layerInput({ regions: [{ rings: [square], mode: "hide", symbols: "all" }] }));
    expect(layer.regions).toEqual(explicit.regions);
    expect(layer.objects.filter((o) => o.ref.kind === "object")).toEqual([]);
    const { hidden } = symbolise({ ...courseRenderInput(isomDocument(), layer), fonts: fonts() });
    expect(hidden).toEqual([0]);
    const both = courseLayer(layerInput({ objects: [stored], regions: [{ rings: [square, hole], mode: "clip", symbols: "all" }] }));
    expect(both.regions.map((r) => r.mode)).toEqual(["clip", "hide"]);
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
    const dashed = courseLayer(layerInput({ objects: [rect("outOfBounds", { stroke: "#a626ff", strokeWidthMm: 0.4, dash: "dashed" })] }));
    expect(dashed.symbols[dashed.objects.find((o) => o.ref.kind === "object")!.symbolIdx].id).toBe("ISOM2017-2:709.c");
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

  it("a toner saver fills a white row on top of the stack, above upper purple and every layout colour (P1); none without one", () => {
    const window = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const text: CourseMapObject = { id: "t", anchor: "map", kind: "text", x: 5, y: 5, text: "x", fontSizeMm: 3, color: "#0000ff" };
    const saver: CourseLayerObject = { id: 7, kind: "toner_saver", geometry: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }], props: {} };
    const oob: CourseLayerObject = { id: 8, kind: "oob_area", geometry: [{ x: 70, y: 70 }, { x: 90, y: 70 }, { x: 90, y: 90 }], props: {} };
    for (const toner of [rect("whiteoutInverted"), saver]) {
      const layer = courseLayer(layerInput({ objects: [text, oob, toner], viewOptions: { window } }));
      const ring = layer.objects.find((o) => o.path.flags.some((f) => f & 16))!;
      const fill = layer.symbols[ring.symbolIdx];
      if (fill.type !== "area") throw new Error("the ring is not an area");
      const row = fill.fill ?? -1;
      expect(row).toBe(layer.colours.length - 1);
      expect(layer.colours[row]).toMatchObject({ id: "course:toner-saver-white", cmyk: [0, 0, 0, 0] });
      // Symbolised with the document: the ring is the last pass — after the map's black, the course's upper
      // purple (numbers, the 709 area) and the layout text's own row.
      const { stream } = symbolise({ ...courseRenderInput(isomDocument(), layer), fonts: fonts() });
      const ids = stream.passes.map((p) => colourId(layer, p.colour));
      expect(ids.at(-1)).toBe("course:toner-saver-white");
      expect(ids.filter((id) => id === "course:toner-saver-white")).toHaveLength(1);
      expect(ids).toEqual(expect.arrayContaining(["black100", "purple-upper", "course-object:#0000ff"]));
    }
    // A plain white-out stays at upper white, and no row is added without a toner saver.
    const plain = courseLayer(layerInput({ objects: [rect("whiteout")], viewOptions: { window } }));
    expect(plain.colours.some((c) => c.id === "course:toner-saver-white")).toBe(false);
    // Nor when the saver is not drawn (no window: the viewer, WINDOW_MISSING).
    expect(courseLayer(layerInput({ objects: [saver] })).colours.some((c) => c.id === "course:toner-saver-white")).toBe(false);
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

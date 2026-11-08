/** `courseLayer()` through `symbolise` with a document (course-layer.md §1, §3). */

import { describe, expect, it } from "vitest";
import { courseLayer, courseRenderInput, legLine } from "../layer.js";
import { courseDocumentContext } from "../context.js";
import { layerInput, linear, site, sprintContext } from "./helpers.js";
import { materialiseLibrary } from "../../symbol-library/index.js";
import { symbolise } from "../../render/symbolise.js";
import { makePath } from "../../render/pass-stream.js";
import { flattenRings, pointInRings } from "../../render/geometry.js";
import { liberation } from "../../render/__tests__/fonts.js";
import type { RenderObject } from "../../render/symbolise.js";
import type { CourseLayerObject } from "../objects.js";
import type { CourseLegProps } from "../types.js";

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

describe("variation tints (§12.7, F7)", () => {
  // The spine S → 31 → 33 → F with a none leg across the group, and the alternatives as tinted branches.
  const structures = () => [
    linear(["S", "31", "33", "F"], { id: "c1", items: [{ siteId: "S" }, { siteId: "31" }, { siteId: "33", leg: { style: "none" } }, { siteId: "F" }] }),
    { ...linear(["31", "32", "33"]), id: "c1:g:A", tint: "A" },
    { ...linear(["31", "33"]), id: "c1:g:B", tint: "B" },
  ];
  const legSymbol = (layer: ReturnType<typeof courseLayer>, id: string) =>
    layer.symbols[layer.objects.find((o) => o.ref.kind === "leg" && o.ref.id === id)!.symbolIdx];

  it("with allVariations, each tint has its row on top and the tinted courses' legs and own circles use it", () => {
    const layer = courseLayer(layerInput({ structure: structures(), viewOptions: { allVariations: true } }));
    const ids = layer.colours.map((c) => c.id);
    expect(ids.slice(-2)).toEqual(["course-tint:A", "course-tint:B"]);
    expect(layer.colours.at(-1)!.cmyk).not.toEqual(layer.colours.at(-2)!.cmyk);
    const a = legSymbol(layer, "c1:g:A:0"), b = legSymbol(layer, "c1:g:B:0");
    expect(a.type === "line" && colourId(layer, a.main!.colour)).toBe("course-tint:A");
    expect(b.type === "line" && colourId(layer, b.main!.colour)).toBe("course-tint:B");
    expect(legSymbol(layer, "c1:0").id).not.toContain("tint");
    // 32 is visited by A alone: tinted; 31 by the spine too: plain purple.
    const circleOf = (id: string) => layer.symbols[layer.objects.find((o) => o.ref.kind === "site" && o.ref.id === id)!.symbolIdx];
    const c32 = circleOf("32");
    expect(c32.type === "line" && colourId(layer, c32.main!.colour)).toBe("course-tint:A");
    expect(circleOf("31").id).not.toContain("tint");
  });

  it("without the option a tint is ignored: the layer equals the untinted structures'", () => {
    const tinted = courseLayer(layerInput({ structure: structures() }));
    const plain = courseLayer(layerInput({ structure: structures().map(({ tint: _t, ...s }) => s) }));
    expect(tinted).toEqual(plain);
    expect(tinted.colours.some((c) => c.id.startsWith("course-tint:"))).toBe(false);
  });

  it("the tint rows stay below a toner saver's white", () => {
    const toner = { id: "t", kind: "toner_saver", geometry: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 90 }], props: { marginMm: 5 } } as unknown as CourseLayerObject;
    const window = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const layer = courseLayer(layerInput({ structure: structures(), objects: [toner], viewOptions: { allVariations: true, window } }));
    expect(layer.colours.map((c) => c.id).slice(-3)).toEqual(["course-tint:A", "course-tint:B", "course:toner-saver-white"]);
  });
});

describe("crossings and map-issue points (§10.3, F4)", () => {
  const P = site("P", "crossing_point", 25, 10);
  const MI = site("MI", "map_issue", 50, 60);
  const sites = [site("S", "start", 10, 10), site("31", "control", 40, 10), site("32", "control", 60, 40), P, MI];
  const layerOf = (crossing: CourseLegProps["crossing"], over: Parameters<typeof layerInput>[0] = {}) =>
    courseLayer(layerInput({ sites, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { crossing } }, { siteId: "32" }] }), ...over }));
  const siteObjects = (layer: ReturnType<typeof courseLayer>, id: string) => layer.objects.filter((o) => o.ref.kind === "site" && o.ref.id === id);
  const xs = (o: { path: { coords: ArrayLike<number> } }) => Array.from(o.path.coords).filter((_, i) => i % 2 === 0);
  const ys = (o: { path: { coords: ArrayLike<number> } }) => Array.from(o.path.coords).filter((_, i) => i % 2 === 1);

  it("ISOM: one 710 line along the leg over the body length, lower purple, under black's top", () => {
    const layer = layerOf({ controlId: "P" });
    const [o] = siteObjects(layer, "P");
    expect(layer.symbols[o.symbolIdx].id).toBe("ISOM2017-2:710");
    // Due east, 3.0 mm centred on the site.
    expect(xs(o)).toEqual([23500, 26500]);
    expect(ys(o)).toEqual([10000, 10000]);
    const section = siteObjects(layerOf({ controlId: "P", section: true }), "P")[0];
    expect(xs(section)).toEqual([22000, 28000]);
    const input = courseRenderInput(isomDocument(), layer);
    const { stream } = symbolise({ ...input, fonts: fonts() });
    const k = layer.objects.indexOf(o) + input.courseObjectOffset;
    const passes = stream.passes.filter((_, j) => stream.objectIdx[j] === k);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((p) => colourId(layer, p.colour) === "purple-lower")).toBe(true);
  });

  it("ISSprOM: 710.1 turned along the leg; a section is two 710.2 lines in upper purple", () => {
    const sprint = { document: sprintContext() };
    const [pt] = siteObjects(layerOf({ controlId: "P" }, sprint), "P");
    const layer = layerOf({ controlId: "P" }, sprint);
    expect(layer.symbols[pt.symbolIdx].id).toBe("ISSprOM2019-2:710.1");
    expect(pt.angleDeg).toBeCloseTo(0, 9);
    const sec = siteObjects(layerOf({ controlId: "P", section: true }, sprint), "P");
    expect(sec).toHaveLength(2);
    const secLayer = layerOf({ controlId: "P", section: true }, sprint);
    expect(sec.every((o) => secLayer.symbols[o.symbolIdx].id === "ISSprOM2019-2:710.2")).toBe(true);
    expect(ys(sec[0])).toEqual([10750, 10750]);
    // The second runs the other way, so its ends curve outwards too.
    expect(ys(sec[1])).toEqual([9250, 9250]);
    expect(xs(sec[1])).toEqual([28000, 22000]);
  });

  it("702 only with setter marks; the leg draws through the crossing in one piece", () => {
    expect(siteObjects(layerOf({ controlId: "P" }), "MI")).toEqual([]);
    const marked = layerOf({ controlId: "P" }, { viewOptions: { setterMarks: true } });
    const [mi] = siteObjects(marked, "MI");
    expect(marked.symbols[mi.symbolIdx].id).toBe("ISOM2017-2:702");
    expect(mi.angleDeg).toBeUndefined();
    const legs = marked.objects.filter((o) => o.ref.kind === "leg" && o.ref.id === "c1:0");
    expect(legs).toHaveLength(1);
    // No number for a crossing or a map-issue point.
    expect(marked.objects.filter((o) => o.ref.kind === "number").map((o) => o.ref.id)).toEqual(["31", "32"]);
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

describe("corridors (§10.2, F2)", () => {
  // S (10, 10) → 31 (40, 10) at 1:15 000: 60 m = 4 mm, the edge at y = 8 / 12, the band to 5 / 15.
  const corridor = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 0.5 };
  const withLeg = (leg: CourseLegProps, over: Parameters<typeof layerInput>[0] = {}) =>
    courseLayer(layerInput({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg }, { siteId: "32" }] }), ...over }));
  const far = [{ x: 80, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 90 }];

  it("the band is one clip region of every symbol, after the explicit and the stored regions", () => {
    const stored: CourseLayerObject = { id: 4, kind: "filter_region", geometry: far, props: { mode: "hide", symbols: "all" } };
    const layer = withLeg({ corridor }, { objects: [stored], regions: [{ rings: [far], mode: "hide", symbols: "all" }] });
    expect(layer.regions.map((r) => r.mode)).toEqual(["hide", "hide", "clip"]);
    const band = layer.regions.at(-1)!;
    expect(band.symbols).toBe("all");
    expect(band.invert).toBeUndefined();
    const rings = flattenRings(band.path);
    expect(pointInRings(rings, 25000, 13500)).toBe(true);
    expect(pointInRings(rings, 25000, 6500)).toBe(true);
    expect(pointInRings(rings, 25000, 10000)).toBe(false);
    expect(pointInRings(rings, 25000, 16000)).toBe(false);
  });

  it("masks the map's 516 across the band and never a course pass", () => {
    const layer = withLeg({ corridor });
    const input = courseRenderInput(isomDocument(), layer);
    const { stream, warnings } = symbolise({ ...input, fonts: fonts() });
    expect(warnings).toEqual([]);
    const masked = stream.passes.map((_, k) => stream.maskIdx?.[k] ?? -1);
    const doc = masked.filter((_, k) => stream.objectIdx[k] < input.courseObjectOffset);
    expect(doc.length).toBeGreaterThan(0);
    expect(doc.every((m) => m >= 0)).toBe(true);
    expect(masked.filter((_, k) => stream.objectIdx[k] >= input.courseObjectOffset).every((m) => m === -1)).toBe(true);
  });

  it("the edge: closed 705 strokes of the inside, ref kind corridor; none without edge; a `none` leg keeps both", () => {
    const layer = withLeg({ corridor });
    const edges = layer.objects.filter((o) => o.ref.kind === "corridor");
    expect(edges).toHaveLength(1);
    // F19: the round-capped 705/edge, not the leg's 705.
    expect(layer.symbols[edges[0].symbolIdx].id).toBe(`${layer.symbols[layer.objects.find((o) => o.ref.kind === "leg")!.symbolIdx].id}/edge`);
    expect(edges[0].path.closed).toBe(true);
    expect(edges[0].ref).toEqual({ kind: "corridor", id: "c1:0" });
    // Its points lie on the edge: 2 mm from the leg's line (or its round ends).
    const c = edges[0].path.coords;
    for (let i = 0; i < c.length; i += 2) {
      const x = Math.max(10000, Math.min(40000, c[i]));
      expect(Math.abs(Math.hypot(c[i] - x, c[i + 1] - 10000) - 2000)).toBeLessThan(30);
    }
    expect(withLeg({ corridor: { ...corridor, edge: false } }).objects.some((o) => o.ref.kind === "corridor")).toBe(false);
    const none = withLeg({ style: "none", corridor });
    expect(none.objects.some((o) => o.ref.kind === "leg" && o.ref.id === "c1:0")).toBe(false);
    expect(none.objects.some((o) => o.ref.kind === "corridor")).toBe(true);
    expect(none.regions).toHaveLength(1);
  });

  it("legLine (F14): 705 unless the leg has a corridor, 707 always, none never", () => {
    expect(legLine({ style: "line" })).toBe("line");
    expect(legLine({ style: "line", corridor })).toBeNull();
    expect(legLine({ style: "marked_route" })).toBe("marked_route");
    expect(legLine({ style: "marked_route", corridor })).toBe("marked_route");
    expect(legLine({ style: "none" })).toBeNull();
    expect(legLine({ style: "none", corridor })).toBeNull();
  });

  it("a corridor leg draws no 705 (F14): no leg object, the edge and band kept, the pieces and numbers unchanged; 707 kept", () => {
    const layer = withLeg({ corridor });
    expect(layer.objects.filter((o) => o.ref.kind === "leg").map((o) => o.ref.id)).toEqual(["c1:1"]);
    expect(layer.objects.filter((o) => o.ref.kind === "corridor")).toHaveLength(1);
    expect(layer.regions).toHaveLength(1);
    const plain = withLeg({});
    expect(layer.derivation.courses[0].legs[0].pieces).toEqual(plain.derivation.courses[0].legs[0].pieces);
    expect(layer.objects.filter((o) => o.ref.kind === "number").map((o) => [o.text, o.path.coords])).toEqual(
      plain.objects.filter((o) => o.ref.kind === "number").map((o) => [o.text, o.path.coords]));
    const route = withLeg({ style: "marked_route", corridor });
    const drawn = route.objects.filter((o) => o.ref.kind === "leg" && o.ref.id === "c1:0");
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((o) => route.symbols[o.symbolIdx].id.includes("707"))).toBe(true);
  });

  it("no band without whiteMm; no corridor, nothing new", () => {
    expect(withLeg({ corridor: { ...corridor, whiteMm: 0 } }).regions).toEqual([]);
    const plain = withLeg({});
    expect(plain.regions).toEqual([]);
    expect(plain.objects).toEqual(courseLayer(layerInput({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31" }, { siteId: "32" }] }) })).objects);
  });
});

describe("course objects as F12 moved layout objects (§3.6 retired, §8.3)", () => {
  const box = [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 25 }, { x: 20, y: 25 }];
  const area = (id: string, kind: "whiteout" | "toner_saver" | "oob_area", props: Record<string, unknown> = {}): CourseLayerObject =>
    ({ id, kind, geometry: box, props }) as CourseLayerObject;
  const ref = (id: string) => `course-object:${id}`;

  it("white-out at upper white, 709 / 709.b / 709.c by border, text in its own row on top at paper mm", () => {
    const objects: CourseLayerObject[] = [
      area("wo", "whiteout"),
      area("b", "oob_area", { border: "solid" }),
      area("c", "oob_area", { border: "dashed" }),
      { id: "t", kind: "text", geometry: [{ x: 5, y: 5 }], props: { text: "{course}", fontSizeMm: 2, color: "#0000ff" } },
    ];
    const layer = courseLayer(layerInput({ objects, viewOptions: { textValues: { course: "Lång" } } }));
    const byRef = (id: string) => layer.objects.filter((o) => o.ref.kind === "object" && o.ref.id === ref(id));
    const sym = (id: string) => layer.symbols[byRef(id)[0].symbolIdx];
    expect(sym("wo")).toMatchObject({ type: "area", fill: layer.colours.findIndex((c) => c.paletteIds?.includes("white-upper")) });
    expect(sym("b").id).toBe("ISOM2017-2:709.b");
    expect(byRef("b")).toHaveLength(1);
    expect(sym("c").id).toBe("ISOM2017-2:709.c");
    expect(layer.colours.at(-1)!.id).toBe("course-object:#0000ff");
    expect(byRef("t")[0].text).toBe("Lång");
    // Sizes are paper mm: the migration divided a layout text's page size by the enlargement once.
    expect(sym("t")).toMatchObject({ type: "text", fontSizeUm: 2000 });
  });

  it("white-out outside: the window ring with the shape as a hole; warned without a window", () => {
    const window = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const layer = courseLayer(layerInput({ objects: [area("ts", "toner_saver")], viewOptions: { window } }));
    const ring = layer.objects.find((o) => o.ref.kind === "object")!;
    expect(ring.path.coords.length).toBe(16);
    expect(ring.path.flags[4] & 16).toBe(16);
    const missing = courseLayer(layerInput({ objects: [area("ts", "toner_saver")] }));
    expect(missing.objects.filter((o) => o.ref.kind === "object")).toEqual([]);
    expect(missing.warnings.map((w) => w.code)).toEqual(["WINDOW_MISSING"]);
  });

  it("a toner saver fills a white row on top of the stack, above upper purple and every object colour (P1); none without one", () => {
    const window = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const text: CourseLayerObject = { id: 6, kind: "text", geometry: [{ x: 5, y: 5 }], props: { text: "x", fontSizeMm: 3, color: "#0000ff" } };
    const saver: CourseLayerObject = { id: 7, kind: "toner_saver", geometry: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }], props: {} };
    const oob: CourseLayerObject = { id: 8, kind: "oob_area", geometry: [{ x: 70, y: 70 }, { x: 90, y: 70 }, { x: 90, y: 90 }], props: {} };
    const layer = courseLayer(layerInput({ objects: [text, oob, saver], viewOptions: { window } }));
    const ring = layer.objects.find((o) => o.path.flags.some((f) => f & 16))!;
    const fill = layer.symbols[ring.symbolIdx];
    if (fill.type !== "area") throw new Error("the ring is not an area");
    const row = fill.fill ?? -1;
    expect(row).toBe(layer.colours.length - 1);
    expect(layer.colours[row]).toMatchObject({ id: "course:toner-saver-white", cmyk: [0, 0, 0, 0] });
    // Symbolised with the document: the ring is the last pass — after the map's black, the course's upper
    // purple (numbers, the 709 area) and the text's own row.
    const { stream } = symbolise({ ...courseRenderInput(isomDocument(), layer), fonts: fonts() });
    const ids = stream.passes.map((p) => colourId(layer, p.colour));
    expect(ids.at(-1)).toBe("course:toner-saver-white");
    expect(ids.filter((id) => id === "course:toner-saver-white")).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(["black100", "purple-upper", "course-object:#0000ff"]));
    // A plain white-out stays at upper white, and no row is added without a toner saver.
    const plain = courseLayer(layerInput({ objects: [area("wo", "whiteout")], viewOptions: { window } }));
    expect(plain.colours.some((c) => c.id === "course:toner-saver-white")).toBe(false);
    // Nor when the saver is not drawn (no window: the viewer, WINDOW_MISSING).
    expect(courseLayer(layerInput({ objects: [saver] })).colours.some((c) => c.id === "course:toner-saver-white")).toBe(false);
  });

  it("image objects are returned for the page backends, not as objects", () => {
    const img: CourseLayerObject = { id: "img", kind: "image", geometry: [{ x: 4, y: 6 }, { x: 1, y: 2 }], props: { graphicId: 3, crop: { x: 0, y: 0.5, width: 1, height: 0.5 } } };
    const layer = courseLayer(layerInput({ objects: [img] }));
    expect(layer.images).toEqual([{ graphicId: 3, crop: { x: 0, y: 0.5, width: 1, height: 0.5 }, rectUm: { x: 1000, y: 2000, width: 3000, height: 4000 } }]);
    expect(layer.objects.some((o) => o.ref.kind === "object")).toBe(false);
  });
});

describe("courseDocumentContext", () => {
  const colours = layerInput().document.colours;
  it("reads the matched library and factor; unmatched documents choose by scale", () => {
    expect(courseDocumentContext({ colours, library: { id: "ISOM2017-2", version: "x" }, documentFactor: 1.5, mapScale: 10000 })).toMatchObject({ libraryId: "ISOM2017-2", documentFactor: 1.5, mapScale: 10000 });
    expect(courseDocumentContext({ colours, library: null, documentFactor: 1, mapScale: 10000 })).toMatchObject({ libraryId: "ISOM2017-2", documentFactor: 1.5, mapScale: 10000 });
    expect(courseDocumentContext({ colours, library: null, documentFactor: 1, mapScale: 4000 })).toMatchObject({ libraryId: "ISSprOM2019-2", documentFactor: 1, mapScale: 4000 });
  });

  it("a site at the origin is not drawn", () => {
    const layer = courseLayer(layerInput({ sites: [site("31", "control", 0, 0)], structure: linear(["31"]) }));
    expect(layer.objects).toEqual([]);
  });
});

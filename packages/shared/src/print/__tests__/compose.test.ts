/**
 * The composer (docs/course-print.md §4–6): one map stream with document
 * and course in colour order, the page layer on the same colour table,
 * the description block, the frame ring of a white-out outside, images.
 */

import { describe, expect, it } from "vitest";
import { CourseStackError } from "../../course/colour-stack.js";
import { pathRings } from "../../render/path.js";
import { liberation } from "../../render/__tests__/fonts.js";
import { pageScene } from "../__fixtures__/pages.js";
import { RING_BLEED_UM, composePage } from "../compose.js";
import { frameInMap } from "../page.js";

const fonts = () => [liberation().sans, liberation().narrow];
const idOf = (colours: { paletteIds?: string[]; id: string }[], paletteId: string) => colours.findIndex((c) => c.paletteIds?.includes(paletteId));

describe("composePage", () => {
  it("map layer: document and course in one colour-sorted stream, lower purple under black, upper purple above", () => {
    const page = composePage(pageScene("page-sprint-a4"), fonts());
    const passes = page.mapLayer.stream.passes;
    const colours = passes.map((p) => p.colour);
    expect([...colours].sort((a, b) => a - b)).toEqual(colours);
    const lower = idOf(page.colours, "purple-lower"), upper = idOf(page.colours, "purple-upper"), black = idOf(page.colours, "black100");
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(lower).toBeLessThan(black);
    expect(black).toBeLessThan(upper);
    // The course draws in purple: circles and legs (lower in ISSprOM) and upper elements where the library puts them.
    expect(colours.some((c) => c === lower || c === upper)).toBe(true);
    expect(page.mapLayer.transform.scaleRatio).toBeCloseTo(4000 / 3000, 12);
    expect(page.marksLayer).toBeNull();
    expect(page.warnings).toEqual([]);
  });

  it("page layer: description block text, rules and pictogram glyphs on colours appended to the stack", () => {
    const page = composePage(pageScene("page-sprint-a4"), fonts());
    const passes = page.pageLayer.stream.passes;
    const white = page.colours.findIndex((c) => c.id === "course-object:#ffffff");
    const ink = page.colours.findIndex((c) => c.id === "course-object:#000000");
    expect(white).toBeGreaterThan(idOf(page.colours, "purple-upper"));
    expect(ink).toBe(white + 1);
    expect(passes.some((p) => p.kind === "fill" && p.colour === white)).toBe(true);
    expect(passes.filter((p) => p.kind === "text" && p.colour === ink).length).toBeGreaterThan(10);
    expect(passes.some((p) => p.kind === "glyph" && p.colour === ink)).toBe(true);
    expect(page.pageLayer.stream.glyphTable.length).toBeGreaterThan(3);
  });

  it("no description block when the template hides it", () => {
    const page = composePage({ ...pageScene("page-sprint-a4"), description: null, objects: [] }, fonts());
    expect(page.pageLayer.stream.passes).toEqual([]);
  });

  it("white-out outside: the map ring's outer boundary is the frame (+1 mm under the clip) through T_map⁻¹; the page white-out is upper white", () => {
    const page = composePage(pageScene("page-ring"), fonts());
    const whiteUpper = idOf(page.colours, "white-upper");
    const ring = page.mapLayer.stream.passes.find((p) => p.kind === "fill" && p.colour === whiteUpper && pathRings(p.path).length === 2);
    expect(ring).toBeDefined();
    const f = page.frameUm, d = RING_BLEED_UM;
    const outer = frameInMap(page.mapLayer.transform, { x: f.x - d, y: f.y - d, width: f.width + 2 * d, height: f.height + 2 * d });
    if (ring?.kind !== "fill") throw new Error("kind");
    expect(ring.path.coords[0]).toBe(Math.round(outer[0].x * 1000));
    expect(ring.path.coords[1]).toBe(Math.round(outer[0].y * 1000));
    const pageFill = page.pageLayer.stream.passes.find((p) => p.kind === "fill" && p.colour === whiteUpper);
    expect(pageFill).toBeDefined();
    // The page white-out at (84, 62) 32 × 24 page mm, y-up: lower-left (84, 90 − 86).
    expect(Array.from(pageFill!.kind === "fill" ? pageFill!.path.coords.slice(0, 2) : [])).toEqual([84000, 4000]);
  });

  it("a page-anchored white-out outside rings the frame grown by 1 mm", () => {
    const base = pageScene("page-ring");
    const page = composePage({ ...base, objects: [{ id: "pr", anchor: "page", kind: "rectangle", x: 50, y: 30, width: 20, height: 20, fillMode: "whiteoutInverted" }] }, fonts());
    const ring = page.pageLayer.stream.passes.find((p) => p.kind === "fill" && pathRings(p.path).length === 2);
    if (ring?.kind !== "fill") throw new Error("no ring");
    const f = page.frameUm, d = RING_BLEED_UM;
    expect(Array.from(ring.path.coords.slice(0, 4))).toEqual([f.x - d, f.y - d, f.x + f.width + d, f.y - d]);
  });

  it("page text expands placeholders", () => {
    const page = composePage(pageScene("page-ring"), fonts());
    const text = page.pageLayer.stream.passes.filter((p) => p.kind === "text");
    expect(text.reduce((n, p) => n + (p.kind === "text" ? p.glyphs.length : 0), 0)).toBe("Bana2".length); // the space draws nothing
  });

  it("rotated window: T_map turns counter-clockwise on the page by the window's clockwise rotation", () => {
    const page = composePage(pageScene("page-rotated"), fonts());
    expect(page.mapLayer.transform.rotationDeg).toBe(-20);
    expect(page.mapLayer.stream.passes.some((p) => p.kind === "text")).toBe(true);
  });

  it("images: map- and page-anchored image objects become page images in their layer's space", () => {
    const base = pageScene("page-ring");
    const page = composePage(
      {
        ...base,
        objects: [
          ...base.objects,
          { id: "logo", anchor: "page", kind: "image", graphicId: 7, x: 10, y: 10, width: 20, height: 10 },
          { id: "map-logo", anchor: "map", kind: "image", graphicId: 8, x: -5, y: -5, width: 10, height: 4, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
        ],
      },
      fonts(),
    );
    expect(page.images).toEqual([
      { layer: "map", graphicId: 8, rectUm: { x: -5000, y: -5000, width: 10000, height: 4000 }, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
      { layer: "page", graphicId: 7, rectUm: { x: 10000, y: 70000, width: 20000, height: 10000 } },
    ]);
  });

  it("an unaligned document stack is a CourseStackError", () => {
    const base = pageScene("page-ring");
    const colours = base.map.context.colours.map((c) => ({ ...c, paletteIds: [] }));
    expect(() => composePage({ ...base, map: { ...base.map, context: { ...base.map.context, colours } } }, fonts())).toThrow(CourseStackError);
  });
});

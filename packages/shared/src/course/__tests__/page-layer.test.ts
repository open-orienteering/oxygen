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
import { courseLayer } from "../layer.js";
import { pageLayer, pageStreamInMap } from "../page-layer.js";

const fonts = () => [liberation().sans, liberation().narrow];

function layerColours(name: "page-sprint-a4" | "page-ring") {
  const input = pageScene(name);
  const layer = courseLayer({ ...input.course, objects: input.objects, document: input.map.context });
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

  it("draws only page-anchored objects: no page objects and no block, an empty stream", () => {
    const { input, colours } = layerColours("page-ring");
    const layer = pageLayer({ ...input, objects: input.objects.filter((o) => o.anchor === "map"), context: input.map.context }, colours, fonts());
    expect(layer.stream.passes).toEqual([]);
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

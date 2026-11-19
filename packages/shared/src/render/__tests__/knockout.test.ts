/**
 * J15 knockout images (docs/map-rendering.md §4.11 "Knockout footprints"): an image with
 * `knockout` masks every image pass below it whose bounds meet its footprint — its quad inset
 * 50 µm in its own frame — and nothing else; filter-region masks are kept and extended.
 */
import { describe, expect, it } from "vitest";
import { KNOCKOUT_INSET_UM, applyKnockouts, knockoutFootprint } from "../filter-region.js";
import { type ImagePass, type Pass, makePath } from "../pass-stream.js";
import { diffPassStreams } from "../stream-json.js";
import { type RenderObject, symbolise } from "../symbolise.js";
import { parseRenderSymbol } from "../symbol.js";

const symbols = [
  parseRenderSymbol({ id: "course:whiteout", code: "w", name: "White-out", type: "area", fill: 2 }),
  parseRenderSymbol({ id: "course:graphics", code: "graphics", name: "Graphics", type: "area", fill: 4 }),
];
const box = (x: number, y: number, w: number, h: number) => makePath([x, y, x + w, y, x + w, y + h, x, y + h], undefined, true);
const img = (path: ReturnType<typeof box>, graphicId: number, extra: Partial<RenderObject> = {}): RenderObject => ({ symbolIdx: 1, path, image: { graphicId }, ...extra });
const run = (objects: RenderObject[]) => symbolise({ fonts: [], symbols, objects }).stream;
const coords = (p: { coords: ArrayLike<number> }) => Array.from(p.coords);

describe("J15 knockout footprint", () => {
  it("is the quad inset 50 µm in its own frame; a quad under 100 µm a side cuts nothing", () => {
    expect(coords(knockoutFootprint([20000, 0, 0, 10000, 1000, 2000])!)).toEqual([1050, 2050, 20950, 2050, 20950, 11950, 1050, 11950]);
    // Turned 30°: each corner moves 50 µm along both of the quad's own axes.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const f = coords(knockoutFootprint([10000 * c, 10000 * s, -10000 * s, 10000 * c, 0, 0])!);
    expect(f[0]).toBe(Math.round(KNOCKOUT_INSET_UM * c - KNOCKOUT_INSET_UM * s));
    expect(f[1]).toBe(Math.round(KNOCKOUT_INSET_UM * s + KNOCKOUT_INSET_UM * c));
    expect(knockoutFootprint([99, 0, 0, 10000, 0, 0])).toBeNull();
  });
});

describe("J15 symbolise with knockout images", () => {
  const overlay = img(box(0, 0, 100000, 100000), 1);
  const lucka = img(box(40000, 40000, 20000, 20000), 2, { knockout: true });

  it("an upper knockout masks the image below by its footprint; it is not masked itself; no knockout = the same stream", () => {
    const s = run([overlay, lucka]);
    const at = (g: number) => s.passes.findIndex((p) => p.kind === "image" && p.graphicId === g);
    expect(s.maskIdx![at(1)]).toBe(0);
    expect(s.maskIdx![at(2)]).toBe(-1);
    expect(coords(s.masks![0].regions[0])).toEqual([40050, 40050, 59950, 40050, 59950, 59950, 40050, 59950]);
    const plain = run([overlay, { ...lucka, knockout: undefined }]);
    expect(plain.masks).toBeUndefined();
    expect(plain.maskIdx).toBeUndefined();
  });

  it("only what is below: a knockout under the overlay cuts nothing", () => {
    const s = run([lucka, overlay]);
    expect(s.maskIdx).toBeUndefined();
  });

  it("several knockouts give one mask with each footprint; a far image is not masked; a knockout below another is cut by it", () => {
    const far = img(box(200000, 200000, 10000, 10000), 3);
    const second = img(box(10000, 10000, 15000, 15000), 4, { knockout: true });
    const top = img(box(50000, 50000, 20000, 20000), 5, { knockout: true });
    const s = run([far, overlay, second, lucka, top]);
    const m = (g: number) => s.maskIdx![s.passes.findIndex((p) => p.kind === "image" && p.graphicId === g)];
    expect(m(3)).toBe(-1);
    expect(s.masks![m(1)].regions).toHaveLength(3);
    // The lucka overlaps `top`, so it is cut by it; `second` does not meet `top`.
    expect(s.masks![m(2)].regions).toHaveLength(1);
    expect(m(4)).toBe(-1);
    expect(m(5)).toBe(-1);
  });

  it("never masks other kinds: a white-out under the lucka keeps drawing", () => {
    const whiteout: RenderObject = { symbolIdx: 0, path: box(30000, 30000, 40000, 40000) };
    const s = run([whiteout, overlay, lucka]);
    s.passes.forEach((p, i) => {
      if (p.kind !== "image") expect(s.maskIdx![i]).toBe(-1);
    });
  });

  it("opacity and Multiply do not change the cut: the box cuts", () => {
    const s = run([overlay, { ...lucka, opacity: 0, blend: "multiply" }]);
    expect(s.masks).toHaveLength(1);
  });

  it("keeps a filter-region mask and adds the footprints to it", () => {
    const passes: Pass[] = [
      { kind: "image", colour: 4, graphicId: 1, quad: [100000, 0, 0, 100000, 0, 0] } as ImagePass,
      { kind: "image", colour: 4, graphicId: 2, quad: [20000, 0, 0, 20000, 40000, 40000] } as ImagePass,
    ];
    const region = box(0, 0, 5000, 5000);
    const stream = { objectIdx: Uint32Array.from([0, 1]), symbolIdx: new Uint32Array(2), passes, glyphTable: [], fontTable: [], masks: [{ regions: [region] }], maskIdx: Int32Array.from([0, -1]) };
    const out = applyKnockouts(stream, (i) => i === 1);
    expect(out.maskIdx![0]).toBe(0);
    expect(out.masks![0].regions).toHaveLength(2);
    expect(out.masks![0].regions[0]).toBe(region);
    expect(diffPassStreams(applyKnockouts(stream, () => false), stream)).toEqual([]);
  });
});

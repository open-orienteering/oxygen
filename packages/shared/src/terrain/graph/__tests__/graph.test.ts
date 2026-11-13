import { describe, expect, it } from "vitest";
import type { MapDocument } from "../../../map-document/index.js";
import { buildContourGraph, cellIndex, type ContourGraph } from "../index.js";
import { S, line, mapped, ring, syntheticDoc, type Obj } from "./synthetic.js";

function build(objects: Obj[], area?: [number, number, number, number]): { g: ContourGraph; d: MapDocument } {
  const d = syntheticDoc(mapped(objects, area));
  const g = buildContourGraph(d);
  if (!g) throw new Error("no graph");
  return { g, d };
}

const labelAt = (g: ContourGraph, x: number, y: number) => g.raster.labels[cellIndex(g.raster, x, y)];

const NESTED: Obj[] = [
  { sym: S.contour, coords: ring(30, 20, 5) },
  { sym: S.contour, coords: ring(30, 20, 10) },
  { sym: S.contour, coords: ring(30, 20, 15) },
];

describe("chain ↔ region incidence (map-terrain.md §2.6)", () => {
  it("puts the inside of a counter-clockwise ring on its left", () => {
    const { g, d } = build(NESTED);
    const byRadius = [1, 2, 3].map((source) => g.chains.findIndex((c) => d.attrs.sourceIndex[c.objects[0]] === source));
    const regions = [labelAt(g, 30, 20), labelAt(g, 37.5, 20), labelAt(g, 42.5, 20), labelAt(g, 46, 20)];
    byRadius.forEach((ci, k) => {
      expect(g.leaky[ci]).toBe(0);
      expect(g.pairs[ci].map((p) => [p.left, p.right])).toEqual([[regions[k], regions[k + 1]]]);
    });
    expect(g.regionChains[regions[0]]).toEqual(new Map([[byRadius[0], 1]]));
    expect([...g.regionChains[regions[1]].entries()].sort()).toEqual([
      [byRadius[0], 2],
      [byRadius[1], 1],
    ].sort());
    expect(g.stats.graph.components).toBe(1);
    expect(g.stats.graph.leakyChains).toBe(0);
  });

  it("flags a chain whose band runs around it as leaky", () => {
    const { g } = build([NESTED[0], { sym: S.contour, coords: line(40, 30, 50, 30) }]);
    const open = g.chains.findIndex((c) => !c.closed);
    expect(g.leaky[open]).toBe(1);
    expect(g.pairs[open]).toEqual([]);
    expect(g.stats.graph.leakyChains).toBe(1);
    expect(g.stats.graph.leakyLengthMm).toBeCloseTo(10, 9);
  });

  it("links the regions facing each other across a cliff", () => {
    const { g } = build(
      [
        { sym: S.contour, coords: line(0, 20, 60, 20) },
        { sym: S.cliff, coords: line(30, 10, 30, 30) },
      ],
      [0, 15, 60, 25],
    );
    const ll = labelAt(g, 15, 19), lr = labelAt(g, 45, 19), ul = labelAt(g, 15, 21), ur = labelAt(g, 45, 21);
    expect(new Set([ll, lr, ul, ur]).size).toBe(4);
    const link = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
    expect(g.cliffLinks.map(([a, b]) => `${a},${b}`).sort()).toEqual([link(ll, lr), link(ul, ur)].sort());
    // The contour sees both halves of its band on each side.
    expect(g.pairs[0]).toHaveLength(2);
    expect(g.stats.graph.components).toBe(1);
  });
});

describe("buildContourGraph (§2.7)", () => {
  const MIXED: Obj[] = [
    ...NESTED,
    { sym: S.contour, coords: line(0, 3, 60, 3) },
    { sym: S.contour, coords: line(48, 30, 53, 35) },
    { sym: S.index, coords: line(53.1, 35.1, 58, 39) },
    { sym: S.form, coords: line(2, 30, 10, 36) },
    { sym: S.cliffTagged, coords: line(50, 10, 55, 15) },
    { sym: S.tick, coords: [30, 25], angleDeciDeg: 900 },
    { sym: S.water, coords: ring(30, 20, 2) },
  ];

  it("is deterministic: two builds are equal field for field", () => {
    const a = buildContourGraph(syntheticDoc(mapped(MIXED)));
    const b = buildContourGraph(syntheticDoc(mapped(MIXED)));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it("counts what it built", () => {
    const { g } = build(MIXED);
    const s = g.stats;
    expect(s.objects).toMatchObject({ contourObjects: 5, indexObjects: 1, formObjects: 1, ticks: 1, cliffObjects: 1, taggedCliffs: 1, waterAreas: 1 });
    expect(s.contours.chains).toBe(g.chains.length);
    expect(s.contours.closed).toBe(3);
    expect(s.contours.snapJoins).toBe(1);
    expect(s.formLines.chains).toBe(1);
    expect(Object.values(s.openEnds).reduce((a, b) => a + b, 0)).toBe(2 * (s.contours.chains - s.contours.closed));
    expect(s.graph.regions).toBe(g.raster.regionCount);
  });

  it("returns null for a document without contours", () => {
    expect(buildContourGraph(syntheticDoc([{ sym: S.form, coords: line(0, 0, 10, 0) }]))).toBeNull();
  });
});

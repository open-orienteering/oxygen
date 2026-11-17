import { describe, expect, it } from "vitest";
import type { MapDocument } from "../../../map-document/index.js";
import { buildContourGraph, joinEnds, snapJoin, type Chain, type ContourGraph } from "../index.js";
import { S, halves, line, mapped, syntheticDoc, type Obj } from "./synthetic.js";

interface Build {
  scale?: number;
  bridgeGroundM?: number;
  area?: [number, number, number, number];
}

function build(objects: Obj[], o: Build = {}): { g: ContourGraph; d: MapDocument } {
  const d = syntheticDoc(mapped(objects, o.area), o.scale);
  const g = buildContourGraph(d, { bridgeGroundM: o.bridgeGroundM });
  if (!g) throw new Error("no graph");
  return { g, d };
}

/** Source positions of a chain's objects (the mapped area is source 0, so the test's objects start at 1). */
const sources = (d: MapDocument, c: Chain) => c.objects.map((o) => d.attrs.sourceIndex[o]);
const chainOf = (d: MapDocument, g: ContourGraph, source: number) => g.chains.find((c) => sources(d, c).includes(source))!;

describe("snap join and the continuation rule (map-terrain.md §2.1)", () => {
  it("joins two pieces whose ends meet within 0.15 mm in line", () => {
    const { g, d } = build([
      { sym: S.contour, coords: line(5, 20, 20, 20) },
      { sym: S.contour, coords: line(20.1, 20, 35, 20) },
    ]);
    expect(g.stats.contours.snapJoins).toBe(1);
    expect(g.chains).toHaveLength(1);
    expect(sources(d, g.chains[0]).sort()).toEqual([1, 2]);
    expect(g.chains[0].lengthMm).toBeCloseTo(30, 9);
    expect(g.chains[0].ends).toEqual(["dangling", "dangling"]);
  });

  it("does not join ends that turn more than about 70°", () => {
    const { g, d } = build([
      { sym: S.contour, coords: line(5, 20, 20, 20) },
      { sym: S.contour, coords: line(20.1, 20, 20.1, 35) },
    ]);
    expect(g.stats.contours.snapJoins).toBe(0);
    expect(g.chains).toHaveLength(2);
    // Each turned end lies within 0.2 mm of the other chain.
    expect(chainOf(d, g, 1).ends![1]).toBe("merge");
    expect(chainOf(d, g, 2).ends![0]).toBe("merge");
  });

  it("closes a ring drawn in two halves", () => {
    const [a, b] = halves(30, 20, 8);
    const { g } = build([
      { sym: S.contour, coords: a },
      { sym: S.contour, coords: b },
    ]);
    expect(g.stats.contours.snapJoins).toBe(2);
    expect(g.chains).toHaveLength(1);
    expect(g.chains[0].closed).toBe(true);
    expect(g.chains[0].ends).toBeNull();
  });

  it("breaks a tie in score by end order", () => {
    // P0's end continues A's start and B's end equally well (both straight on, distance 0): the earlier end wins.
    const piece = (object: number, pts: number[]) => ({ pts: Float64Array.from(pts), closed: false, index: false, object });
    const p0 = piece(0, line(-10, 0, 0, 0)), a = piece(1, line(0, 0, 10, 0)), b = piece(2, line(10, 0, 0, 0));
    const first = snapJoin([p0, a, b]);
    expect(first.joins).toBe(1);
    expect(first.chains.map((c) => c.objects)).toEqual([[0, 1], [2]]);
    expect(snapJoin([p0, b, a]).chains.map((c) => c.objects)).toEqual([[0, 2], [1]]);
  });

  it("does not close a piece on itself when it is shorter than max(3 · tolerance, 1 mm)", () => {
    // A 2 mm U whose ends lie 0.5 mm apart; every pair is allowed to join.
    const u = Float64Array.from([0, 0, 0, 0.75, 0.5, 0.75, 0.5, 0]);
    const chain: Chain = { pts: u, closed: false, lengthMm: 2, indexLengthMm: 0, index: false, ends: ["dangling", "dangling"], objects: [0] };
    expect(joinEnds([chain], 1, () => true).chains[0].closed).toBe(false);
    expect(joinEnds([chain], 0.6, () => true).chains[0].closed).toBe(true);
  });

  it("joins the straightest pair where three ends meet at a cliff; the third merges", () => {
    const { g, d } = build([
      { sym: S.contour, coords: line(10, 20, 30, 20) },
      { sym: S.contour, coords: line(30, 20, 50, 20) },
      { sym: S.contour, coords: line(45, 27.5, 30, 20) },
      { sym: S.cliff, coords: line(30, 10, 30, 30) },
      // An end 0.3 mm short of the cliff, far from any other contour.
      { sym: S.contour, coords: line(10, 12, 29.7, 12) },
    ]);
    expect(g.stats.contours.snapJoins).toBe(1);
    expect(sources(d, chainOf(d, g, 1)).sort()).toEqual([1, 2]);
    const third = chainOf(d, g, 3);
    expect(sources(d, third)).toEqual([3]);
    expect(third.ends).toEqual(["dangling", "merge"]);
    expect(chainOf(d, g, 5).ends).toEqual(["dangling", "cliff"]);
  });
});

describe("end classes and gap bridging (§2.2)", () => {
  const gap = (dx: number, dy = 0): Obj[] => [
    { sym: S.contour, coords: line(5, 20, 25, 20) },
    { sym: S.contour, coords: line(25 + dx, 20 + dy, 55, 20 + dy) },
  ];

  it("bridges a gap of 45 m on the ground: 4 mm at 1:4 000, not at 1:15 000", () => {
    const at15 = build(gap(4)).g;
    expect(at15.stats.contours.bridgedGaps).toBe(0);
    expect(at15.chains).toHaveLength(2);
    expect(at15.stats.openEnds.dangling).toBe(4);

    const at4 = build(gap(4), { scale: 4000 }).g;
    expect(at4.stats.contours.bridgedGaps).toBe(1);
    expect(at4.chains).toHaveLength(1);
    expect(at4.chains[0].lengthMm).toBeCloseTo(50, 9);
    expect(at4.chains[0].ends).toEqual(["dangling", "dangling"]);
  });

  it("takes the bridge distance as an option in ground metres", () => {
    expect(build(gap(4), { bridgeGroundM: 60 }).g.stats.contours.bridgedGaps).toBe(1);
  });

  it("bridges only when each end looks at the other", () => {
    // 4 mm along, 4 mm aside: 45° off each tangent, outside the 40° cone beyond 1.5 mm.
    expect(build(gap(4, 4), { scale: 4000 }).g.stats.contours.bridgedGaps).toBe(0);
    // 4 mm along, 2 mm aside: 26.6° off, inside.
    expect(build(gap(4, 2), { scale: 4000 }).g.stats.contours.bridgedGaps).toBe(1);
  });

  it("narrows the look-at cone with the gap: forward up to 0.6 mm, 55° up to 1.5 mm", () => {
    // 0.2 mm back and 0.5 mm aside: B starts behind A's end, so A does not look at it.
    expect(build(gap(-0.2, 0.5)).g.stats.contours.bridgedGaps).toBe(0);
    // 0.3 mm along, 0.4 mm aside (0.5 mm): 53° off, yet forward — bridged.
    expect(build(gap(0.3, 0.4)).g.stats.contours.bridgedGaps).toBe(1);
    // 1.0 along, 0.8 aside (1.28 mm): 38.7° off, inside 55°.
    expect(build(gap(1, 0.8)).g.stats.contours.bridgedGaps).toBe(1);
    // 0.6 along, 0.9 aside (1.08 mm): 56.3° off, outside.
    expect(build(gap(0.6, 0.9)).g.stats.contours.bridgedGaps).toBe(0);
  });

  it("bridges only dangling ends: a merge or cliff end stays open", () => {
    const atCliff = build([...gap(4), { sym: S.cliff, coords: line(25.3, 15, 25.3, 25) }], { scale: 4000 });
    expect(atCliff.g.stats.contours.bridgedGaps).toBe(0);
    expect(atCliff.g.stats.openEnds.cliff).toBe(1);
    const atMerge = build([...gap(4), { sym: S.contour, coords: line(25.1, 10, 25.1, 30) }], { scale: 4000 });
    expect(atMerge.g.stats.contours.bridgedGaps).toBe(0);
    expect(atMerge.g.stats.openEnds.merge).toBe(1);
  });

  it("drops chains of 0.3 mm or less", () => {
    const { g, d } = build([
      { sym: S.contour, coords: line(10, 20, 30, 20) },
      { sym: S.contour, coords: [20, 25, 20.25, 25] },
    ]);
    expect(g.inputs.contours).toHaveLength(2);
    expect(g.chains.map((c) => sources(d, c))).toEqual([[1]]);
  });

  it("classifies an end cut by the edge of the mapped area as frame", () => {
    const { g } = build([{ sym: S.contour, coords: line(0, 20, 60, 20) }], { area: [0, 15, 60, 25] });
    expect(g.chains[0].ends).toEqual(["frame", "frame"]);
    expect(g.stats.openEnds.frame).toBe(2);
  });

  it("leaves a lone end in the open dangling", () => {
    const { g } = build([{ sym: S.contour, coords: line(20, 20, 40, 20) }]);
    expect(g.chains[0].ends).toEqual(["dangling", "dangling"]);
    expect(g.stats.openEnds.dangling).toBe(2);
  });

  it("bridges the dangling ends between two frame ends", () => {
    const { g } = build(
      [
        { sym: S.contour, coords: line(0, 20, 30, 20) },
        { sym: S.contour, coords: line(32, 20, 60, 20) },
      ],
      { scale: 4000, area: [0, 15, 60, 25] },
    );
    expect(g.stats.contours.bridgedGaps).toBe(1);
    expect(g.chains).toHaveLength(1);
    expect(g.chains[0].ends).toEqual(["frame", "frame"]);
  });

  it("marks a chain as index when more than half its length is index contour", () => {
    const { g } = build([
      { sym: S.index, coords: line(5, 20, 30, 20) },
      { sym: S.contour, coords: line(30.1, 20, 50, 20) },
      { sym: S.contour, coords: line(5, 10, 30, 10) },
      { sym: S.index, coords: line(30.1, 10, 50, 10) },
    ]);
    expect(g.chains.map((c) => c.index).sort()).toEqual([false, true]);
    expect(g.stats.contours.indexChains).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import type { ContourGraph } from "../../graph/index.js";
import { CLIFF_STEP_SOURCE, LevelUnion, NO_LEVEL, TIER, buildForest, edgeKey, forestEdges, type ForestInput } from "../index.js";

/** A graph of `regions` regions and one chain per entry of `pairs` (left, right, samples). */
function graph(regions: number, pairs: [number, number, number][][], links: [number, number][] = []): ContourGraph {
  return {
    chains: pairs.map(() => ({ lengthMm: 10 })),
    pairs: pairs.map((ps) => ps.map(([left, right, samples]) => ({ left, right, samples }))),
    cliffLinks: links,
    raster: { regionCount: regions },
  } as unknown as ContourGraph;
}

function input(g: ContourGraph, side: number[], opts: Partial<ForestInput> = {}): ForestInput {
  return {
    side: Int8Array.from(side),
    flagged: new Uint8Array(side.length),
    cliffBorne: g.pairs.map((ps) => new Uint8Array(ps.length)),
    linkSamples: new Uint32Array(g.cliffLinks.length).fill(5),
    overrides: new Map(),
    leakyRegion: new Uint8Array(g.raster.regionCount + 1),
    ...opts,
  };
}

/** Regions 1 … 4 stacked: chain i has region i + 2 on its left, i + 1 on its right. */
const LADDER: [number, number, number][][] = [[[2, 1, 10]], [[3, 2, 10]], [[4, 3, 10]]];

describe("LevelUnion", () => {
  it("keeps offsets through path compression", () => {
    const u = new LevelUnion(5);
    expect(u.join(1, 0, 1)).toBe(true);
    expect(u.join(2, 1, 1)).toBe(true);
    expect(u.join(4, 3, -2)).toBe(true);
    expect(u.join(3, 2, 1)).toBe(true);
    expect(u.join(2, 0, 2)).toBe(false);
    expect([0, 1, 2, 3, 4].map((r) => u.level(r) - u.level(0))).toEqual([0, 1, 2, 3, 1]);
  });
});

describe("the level forest (map-terrain.md §3.3)", () => {
  it("levels a ladder from 0, chains at their upper side", () => {
    const g = graph(4, LADDER);
    const f = buildForest(g, input(g, [1, 1, 1]));
    expect([...f.regionLevel].slice(1)).toEqual([0, 1, 2, 3]);
    expect([...f.chainLevel]).toEqual([1, 2, 3]);
    expect([...f.chainStep]).toEqual([1, 1, 1]);
    expect(new Set([...f.regionComponent].slice(1)).size).toBe(1);
  });

  it("takes a chain whose sides close a longer cycle as multi-step, not as a conflict", () => {
    const g = graph(4, [...LADDER, [[4, 1, 5]]]);
    const f = buildForest(g, input(g, [1, 1, 1, 1]));
    expect(f.chainStep[3]).toBe(3);
    expect(f.conflict[3]).toBe(0);
    expect(f.conflictLengthMm).toBe(0);
  });

  it("gives a contradicting chain its conflict share", () => {
    // fewer samples than the ladder: both pairs close cycles the wrong way round
    const g = graph(4, [...LADDER, [[4, 1, 5], [3, 1, 5]]]);
    const f = buildForest(g, input(g, [1, 1, 1, -1]));
    expect(f.conflict[3]).toBeCloseTo(1, 9);
    expect(f.conflictLengthMm).toBe(10);
  });

  it("takes weak pairs after strict ones, whatever their samples", () => {
    // chain 2 (region 3 above region 1) has the most samples but runs along a cliff
    const g = graph(3, [[[2, 1, 10]], [[3, 2, 10]], [[3, 1, 100]]]);
    const weak = buildForest(g, input(g, [1, 1, 1], { cliffBorne: [new Uint8Array(1), new Uint8Array(1), Uint8Array.of(1)] }));
    expect(weak.chainStep[2]).toBe(2);
    expect(weak.conflict[1]).toBe(0);
    // taken first, it would have put the ladder's second chain in conflict
    const strong = buildForest(g, input(g, [1, 1, 1]));
    expect(strong.conflict[1]).toBeGreaterThan(0);
  });

  it("takes pairs beside a band that spans two levels as weak", () => {
    const g = graph(4, LADDER);
    const leak = new Uint8Array(5);
    leak[4] = 1;
    const tiers = forestEdges(g, input(g, [1, 1, 1], { leakyRegion: leak })).map((e) => [e.key, e.tier]);
    expect(tiers).toEqual([
      [edgeKey(0, 0), TIER.strict],
      [edgeKey(1, 0), TIER.strict],
      [edgeKey(2, 0), TIER.weakPair],
    ]);
  });

  it("orders flagged pairs after strict ones and undecided chains last", () => {
    const g = graph(4, LADDER);
    const f = input(g, [1, 0, 1]);
    f.flagged[0] = 1;
    expect(forestEdges(g, f).map((e) => [e.key, e.tier])).toEqual([
      [edgeKey(2, 0), TIER.strict],
      [edgeKey(0, 0), TIER.flagged],
      [edgeKey(1, 0), TIER.undecided],
    ]);
  });

  it("joins undecided chains and cliff links at a zero step, as weak links", () => {
    const g = graph(5, [[[2, 1, 10]], [[3, 2, 10]], [[5, 4, 10]]], [[3, 4]]);
    const f = buildForest(g, input(g, [1, 0, 1]));
    expect(f.regionLevel[3]).toBe(f.regionLevel[2]);
    expect(f.regionLevel[4]).toBe(f.regionLevel[3]);
    expect(f.cliffStepSource[0]).toBe(CLIFF_STEP_SOURCE.assumed);
    expect(f.regionComponent[1]).toBe(f.regionComponent[2]);
    expect(f.regionComponent[3]).not.toBe(f.regionComponent[2]);
    expect(f.regionWeak[1] + f.regionWeak[2]).toBe(0);
    expect(f.regionWeak[3] + f.regionWeak[4] + f.regionWeak[5]).toBeGreaterThan(0);
  });

  it("uses a step set by index repair and reports its source", () => {
    const g = graph(4, [[[2, 1, 10]], [[4, 3, 10]]], [[2, 3]]);
    const f = buildForest(g, input(g, [1, 1], { overrides: new Map([[-1, 2]]) }));
    expect(f.regionLevel[3] - f.regionLevel[2]).toBe(2);
    expect(f.cliffStep[0]).toBe(2);
    expect(f.cliffStepSource[0]).toBe(CLIFF_STEP_SOURCE.index);
    // an index-set link is part of the component
    expect(f.regionComponent[4]).toBe(f.regionComponent[1]);
  });

  it("gives a chain without pairs no level", () => {
    const g = graph(2, [[[2, 1, 10]], []]);
    expect(buildForest(g, input(g, [1, 0])).chainLevel[1]).toBe(NO_LEVEL);
  });
});

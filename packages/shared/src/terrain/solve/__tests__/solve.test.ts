import { describe, expect, it } from "vitest";
import { CLASS, FLAGGED_CLASSES, SIGN_CLASSES, cliffBornePairs, leakyRegions, solveTerrain } from "../index.js";
import { S, arc, build, line, regionAt, ring, tick, type Obj } from "./fixtures.js";

/** Five contours across the map, 3 mm apart, drawn eastwards; one tick on the middle one: uphill north. */
const LADDER: Obj[] = [5, 8, 11, 14, 17].map((y): Obj => ({ sym: S.contour, coords: line(0, y, 60, y) }));
const AREA: [number, number, number, number] = [0, 0, 60, 21];
const external = (n: number, set: [number, 1 | -1][]) => {
  const side = new Int8Array(n);
  for (const [c, s] of set) side[c] = s;
  return { source: "test-dem", side };
};

describe("staged signs (map-terrain.md §3.2)", () => {
  it("propagates one tick along a ladder of two-contour bands", () => {
    const { g, chain } = build([...LADDER, tick(30, 11, 0, -1)], AREA);
    const sol = solveTerrain(g);
    const cs = [0, 1, 2, 3, 4].map(chain);
    expect(cs.map((c) => sol.side[c])).toEqual([1, 1, 1, 1, 1]);
    expect(SIGN_CLASSES[sol.signClass[cs[2]]]).toBe("tick");
    expect([0, 1, 3, 4].map((k) => SIGN_CLASSES[sol.signClass[cs[k]]])).toEqual(["slope", "slope", "slope", "slope"]);
    expect(cs.map((c) => sol.root[c])).toEqual(cs.map(() => cs[2]));
    expect(cs.map((c) => sol.chainLevel[c])).toEqual([1, 2, 3, 4, 5]);
    expect(sol.regionLevel[regionAt(g, 30, 4)]).toBe(0);
    expect(sol.report.share.strict).toBeCloseTo(1, 9);
  });

  it("sums evidence both ways by weight and counts the chain", () => {
    // a tick (weight 4) says north is uphill; a tagged cliff drawn on the contour (1.5) says south
    const { g, chain } = build([LADDER[2], tick(30, 11, 0, -1), { sym: S.cliffTagged, coords: line(40, 11.2, 20, 11.2) }], AREA);
    const sol = solveTerrain(g);
    expect(sol.side[chain(0)]).toBe(1);
    expect(sol.signClass[chain(0)]).toBe(CLASS.tick);
    expect(sol.report.evidence.conflictingChains).toBe(1);
  });
});

describe("the external side (answer 14, §3.0)", () => {
  it("decides first, and slope propagation carries it", () => {
    const { g, chain } = build(LADDER, AREA);
    const sol = solveTerrain(g, { external: external(g.chains.length, [[chain(0), -1]]) });
    expect([0, 1, 2, 3, 4].map((k) => sol.side[chain(k)])).toEqual([-1, -1, -1, -1, -1]);
    expect(sol.signClass[chain(0)]).toBe(CLASS.dem);
    expect(sol.signClass[chain(4)]).toBe(CLASS.slope);
    expect(sol.report.external).toMatchObject({ source: "test-dem", chains: 1 });
  });

  it("wins over a tick and reports the disagreement", () => {
    const { g, chain } = build([...LADDER, tick(30, 11, 0, -1)], AREA);
    const sol = solveTerrain(g, { external: external(g.chains.length, [[chain(2), -1]]) });
    expect(sol.side[chain(2)]).toBe(-1);
    expect(sol.signClass[chain(2)]).toBe(CLASS.dem);
    expect(sol.externalDisagrees[chain(2)]).toBe(1);
    expect(sol.report.external?.disagreements).toEqual({ tick: 1, cliff: 0, lake: 0 });
  });

  /**
   * The middle contour drawn in two pieces with a cliff between them: the
   * ticked piece joins the bands either side, so the other piece is decided
   * by closure — unless the external side speaks first.
   */
  const SPLIT: Obj[] = [
    LADDER[0],
    { sym: S.contour, coords: line(0, 11, 27, 11) },
    { sym: S.cliff, coords: line(27, 11, 33, 11) },
    { sym: S.contour, coords: line(33, 11, 60, 11) },
    LADDER[4],
    tick(10, 11, 0, -1),
  ];

  it("wins over closure", () => {
    const { g, chain } = build(SPLIT, AREA);
    const plain = solveTerrain(g);
    expect(plain.signClass[chain(3)]).toBe(CLASS.closure);
    expect(plain.side[chain(3)]).toBe(1);
    expect(plain.flagged[chain(3)]).toBe(1);
    const sol = solveTerrain(g, { external: external(g.chains.length, [[chain(3), -1]]) });
    expect(sol.signClass[chain(3)]).toBe(CLASS.dem);
    expect(sol.side[chain(3)]).toBe(-1);
    expect(sol.flagged[chain(3)]).toBe(0);
  });
});

/** As index-repair.test.ts: a frame-cut depression in a band, decided by the band rule (wrong). */
const NEST: Obj[] = [
  { sym: S.contour, coords: line(0, 20, 60, 20) },
  { sym: S.contour, coords: line(0, 80, 60, 80) },
  tick(40, 20, 0, -1),
  tick(40, 80, 0, -1),
  ...[24, 20, 16].map((r): Obj => ({ sym: S.contour, coords: arc(0, 50, r, -100, 100) })),
];

describe("flagged heuristics (§3.4)", () => {
  it("flags the band rule's decision and what slope propagation takes from it", () => {
    const { g, chain } = build(NEST, [0, 0, 60, 100]);
    const sol = solveTerrain(g);
    const [outer, mid, inner] = [4, 5, 6].map(chain);
    expect(sol.signClass[outer]).toBe(CLASS.bandUpper);
    expect(sol.signClass[mid]).toBe(CLASS.slope);
    expect(sol.root[mid]).toBe(outer);
    expect([outer, mid, inner].map((c) => sol.flagged[c])).toEqual([1, 1, 1]);
    expect(FLAGGED_CLASSES).toContain("bandUpper");
    expect(sol.report.share.flagged).toBeGreaterThan(0);
  });

  it("leaves those chains undecided without heuristics", () => {
    const { g, chain } = build(NEST, [0, 0, 60, 100]);
    const sol = solveTerrain(g, { heuristics: false });
    expect([4, 5, 6].map((k) => sol.side[chain(k)])).toEqual([0, 0, 0]);
    expect(sol.report.share.flagged).toBe(0);
    expect(sol.report.share.undecided).toBeGreaterThan(0);
  });

  it("drains a closed band through its one unknown chain (band-drain)", () => {
    // inside a ring with no evidence of its own, two knolls (tops): the band between them and the ring
    // lies below both, so it drains through the ring, which is its lower boundary
    const { g, chain } = build([{ sym: S.contour, coords: ring(30, 30, 15) }, { sym: S.contour, coords: ring(24, 30, 3) }, { sym: S.contour, coords: ring(36, 30, 3) }]);
    const sol = solveTerrain(g);
    expect(sol.signClass[chain(0)]).toBe(CLASS.bandDrain);
    expect(sol.side[chain(0)]).toBe(1);
    expect(sol.flagged[chain(0)]).toBe(1);
  });

  it("takes an undecided closed contour for a hill as the last default", () => {
    // two rings, nothing else: the inner is a top; the outer borders the frame band and its top
    const { g, chain } = build([{ sym: S.contour, coords: ring(30, 30, 10) }, { sym: S.contour, coords: ring(30, 30, 5) }]);
    const sol = solveTerrain(g, { evidence: { tick: [], cliff: [], lake: [], top: [], formTick: [] } });
    expect(sol.signClass[chain(0)]).toBe(CLASS.closedHill);
    expect(sol.side[chain(0)]).toBe(1);
    expect(sol.flagged[chain(0)]).toBe(1);
  });
});

describe("probes (§3.3)", () => {
  it("marks a pair along a cliff as cliff-borne", () => {
    const { g, chain } = build([LADDER[1], LADDER[2], { sym: S.cliff, coords: line(5, 11.45, 55, 11.45) }], [0, 4, 60, 15]);
    const cb = cliffBornePairs(g);
    expect(g.pairs[chain(1)].length).toBeGreaterThan(0);
    expect([...cb[chain(1)]].every((v) => v === 1)).toBe(true);
    expect([...cb[chain(0)]].every((v) => v === 0)).toBe(true);
  });

  it("marks the band a leaky chain lies in", () => {
    const { g, chain } = build([{ sym: S.contour, coords: ring(30, 30, 15) }, { sym: S.contour, coords: line(25, 30, 35, 30) }]);
    expect(g.leaky[chain(1)]).toBe(1);
    const leak = leakyRegions(g);
    expect(leak[regionAt(g, 30, 33)]).toBe(1);
    expect(leak[regionAt(g, 30, 46.5)]).toBe(0);
  });
});

describe("solution and report (§3.6–3.7)", () => {
  const MIXED: Obj[] = [...LADDER, tick(30, 11, 0, -1), { sym: S.contour, coords: line(20, 15.5, 40, 15.5) }];

  it("is deterministic and leaves the graph as it was", () => {
    const a = build(MIXED, AREA), b = build(MIXED, AREA);
    const pairs = JSON.stringify(a.g.pairs), leaky = [...a.g.leaky];
    const sa = solveTerrain(a.g), sb = solveTerrain(b.g);
    expect(JSON.stringify(sa, (_, v) => (ArrayBuffer.isView(v) ? [...(v as Int32Array)] : v))).toBe(JSON.stringify(sb, (_, v) => (ArrayBuffer.isView(v) ? [...(v as Int32Array)] : v)));
    expect(JSON.stringify(a.g.pairs)).toBe(pairs);
    expect([...a.g.leaky]).toEqual(leaky);
  });

  it("splits the contour length into shares that add up", () => {
    const { g } = build(MIXED, AREA);
    const r = solveTerrain(g).report;
    const s = r.share;
    expect(s.strict + s.flagged + s.undecided + s.leakyUndecided).toBeCloseTo(1, 9);
    expect(s.decided).toBeCloseTo(s.strict + s.flagged - s.conflict, 9);
    expect(Object.values(r.byClass).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(r.lengthMm).toBeCloseTo(g.chains.reduce((a, c) => a + c.lengthMm, 0), 9);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.components.length).toBeGreaterThan(0);
    expect(r.components[0].confidence).toBeGreaterThan(0.9);
  });

  it("counts a leaky chain signed by a tick as leaky-signed", () => {
    const { g, chain } = build([{ sym: S.contour, coords: ring(30, 30, 15) }, { sym: S.contour, coords: line(25, 30, 35, 30) }, tick(30, 30, 0, -1)]);
    expect(g.leaky[chain(1)]).toBe(1);
    const sol = solveTerrain(g);
    expect(sol.side[chain(1)]).toBe(1);
    expect(sol.report.share.leakySigned).toBeGreaterThan(0);
  });
});

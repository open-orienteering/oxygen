import { describe, expect, it } from "vitest";
import { candidateLadders, ladderVote, type VoteChain } from "../ladder.js";
import { circularDist } from "../interval.js";
import { ring, seeded } from "./synthetic-dem.js";

const G = 15; // 1:15 000: 1 km = 66.7 mm
const I = 5;
const KM = 1000 / G;

interface Hill {
  chains: VoteChain[];
  median: number[];
  level: number[];
}

/** Rings every 50 m of ground around (cx, cy), on a ladder at `phase`: ring k (outermost 0) at phase + I·(base + n − k). */
function hill(cx: number, cy: number, phase: number, n = 10, base = 0, noise = 0, seed = 1): Hill {
  const rnd = seeded(seed);
  const out: Hill = { chains: [], median: [], level: [] };
  for (let k = 0; k < n; k++) {
    const r = ((n - k) * 50) / G;
    const level = base + k;
    out.chains.push({ pts: ring(cx, cy, r, 64), closed: true });
    out.median.push(phase + I * level + (rnd() - 0.5) * 2 * noise);
    out.level.push(level);
  }
  return out;
}

function vote(hills: Hill[], contributor?: (i: number) => boolean) {
  const chains = hills.flatMap((h) => h.chains);
  const median = new Float64Array(hills.flatMap((h) => h.median));
  const c = new Uint8Array(chains.length).map((_, i) => (contributor ? (contributor(i) ? 1 : 0) : 1));
  return { chains, median, result: ladderVote({ chains, groundMPerMm: G, intervalM: I, median, contributor: c }) };
}

describe("candidate ladders (§6.6)", () => {
  const ones = (n: number) => new Float64Array(n).fill(1);
  it("finds one shifted ladder", () => {
    const m = new Float64Array(50).map((_, i) => 2.6 + I * i);
    const p = candidateLadders(m, ones(50), I);
    expect(p).toHaveLength(1);
    expect(p[0]).toBeCloseTo(2.6, 6);
  });

  it("finds two ladders, the heavier first", () => {
    const m = new Float64Array(100).map((_, i) => (i < 70 ? 2.6 : 0.1) + I * i);
    const p = candidateLadders(m, ones(100), I);
    expect(p).toHaveLength(2);
    expect(p[0]).toBeCloseTo(2.6, 6);
    expect(p[1]).toBeCloseTo(0.1, 6);
  });

  it("keeps a ladder at the wrap as one", () => {
    const rnd = seeded(3);
    const m = new Float64Array(200).map((_, i) => 4.95 + I * i + (rnd() - 0.5) * 0.3);
    const p = candidateLadders(m, ones(200), I);
    expect(p).toHaveLength(1);
    expect(circularDist(p[0], 4.95, I)).toBeLessThan(0.05);
  });

  it("drops a ladder under 4 % of the length", () => {
    const m = new Float64Array(100).map((_, i) => (i < 97 ? 2.6 : 0.1) + I * i);
    expect(candidateLadders(m, ones(100), I)).toHaveLength(1);
  });

  it("holds one ladder under noise", () => {
    const rnd = seeded(5);
    const m = new Float64Array(300).map((_, i) => 1.2 + I * i + (rnd() - 0.5) * 1.0);
    const p = candidateLadders(m, ones(300), I);
    expect(p).toHaveLength(1);
    expect(p[0]).toBeCloseTo(1.2, 1);
  });

  it("finds none without contributors", () => {
    expect(candidateLadders(new Float64Array(0), new Float64Array(0), I)).toEqual([]);
  });
});

describe("the ladder vote (§6.6–6.7)", () => {
  it("labels two hills on two ladders per hill, with their phases and areas", () => {
    const a = hill(0, 0, 2.6, 10, 0, 0.2, 1);
    const b = hill(2 * KM, 0, 0.1, 10, 3, 0.2, 2);
    const { result: v } = vote([a, b]);
    expect(v.ladders.map((l) => +l.phaseM.toFixed(1)).sort()).toEqual([0.1, 2.6]);
    const la = v.ladders.findIndex((l) => Math.abs(l.phaseM - 2.6) < 0.3);
    const lb = 1 - la;
    for (let i = 0; i < 10; i++) {
      expect(v.label[i]).toBe(la);
      expect(v.label[10 + i]).toBe(lb);
      expect(v.phase[i]).toBeCloseTo(2.6, 0);
      expect(v.phase[10 + i]).toBeCloseTo(0.1, 0);
    }
    expect(v.areas).toHaveLength(2);
    expect(new Set(v.area.slice(0, 10))).toEqual(new Set([v.area[0]]));
    expect(new Set(v.area.slice(10))).toEqual(new Set([v.area[10]]));
    expect(v.area[0]).not.toBe(v.area[10]);
    expect(v.areas[v.area[0]].ladder).toBe(la);
  });

  it("labels chains at the border between two ladders by their own side", () => {
    // Outermost rings 500 m from each centre; centres 1.1 km apart: the outer rings pass 100 m from each other.
    const a = hill(0, 0, 2.6, 10, 0, 0.1, 1);
    const b = hill(1.1 * KM, 0, 0.1, 10, 0, 0.1, 2);
    const { result: v } = vote([a, b]);
    const la = v.label[9];
    const lb = v.label[19];
    expect(la).not.toBe(lb);
    for (let i = 0; i < 10; i++) {
      expect(v.label[i]).toBe(la);
      expect(v.label[10 + i]).toBe(lb);
    }
  });

  it("removes a chain's own evidence: a long chain off the neighbours' ladder is labelled with theirs", () => {
    const a = hill(0, 0, 2.6, 10);
    const odd: Hill = { chains: [{ pts: ring(0, 0, 0.42 * KM, 128), closed: true }], median: [0.1 + 30], level: [0] };
    const { result: v } = vote([a, odd]);
    expect(v.ladders).toHaveLength(2);
    expect(v.member[10]).toBe(v.ladders.findIndex((l) => Math.abs(l.phaseM - 0.1) < 0.2));
    expect(v.label[10]).toBe(v.label[0]);
    expect(v.phase[10]).toBeCloseTo(2.6, 1);
  });

  it("grows the window to reach evidence, and leaves a chain far from any unlabelled", () => {
    const a = hill(0, 0, 2.6, 10);
    const near: Hill = { chains: [{ pts: ring(0.95 * KM, 0, 2, 16), closed: true }], median: [2.6 + 3 * I], level: [3] };
    const far: Hill = { chains: [{ pts: ring(4 * KM, 0, 2, 16), closed: true }], median: [2.6], level: [0] };
    const { result: v } = vote([a, near, far], (i) => i < 10);
    expect(v.label[10]).toBe(0);
    expect(v.label[11]).toBe(-1);
    expect(v.phase[11]).toBeNaN();
    expect(v.area[11]).toBe(-1);
  });

  it("labels a chain exactly when its winner holds 0.6 of the window's evidence", () => {
    // Alternate rings on ladders 2.6 and 0.1: the windows hold both.
    const a = hill(0, 0, 2.6, 12);
    a.median = a.median.map((m, i) => (i % 2 ? m - 2.5 : m));
    const { result: v } = vote([a]);
    expect(v.ladders).toHaveLength(2);
    let unlabelled = 0;
    for (let i = 0; i < 12; i++) {
      expect(v.evidenceM[i]).toBeGreaterThanOrEqual(300);
      expect(v.label[i] >= 0).toBe(v.share[i] >= 0.6);
      if (v.label[i] < 0) unlabelled++;
    }
    expect(unlabelled).toBeGreaterThan(0);
  });

  it("needs 300 m of evidence in the widest window", () => {
    // One short contributor 1 km from the hill: the hill's evidence reaches it, a lone 30 m chain's does not reach the hill's far side.
    const lone: Hill = { chains: [{ pts: ring(1.05 * KM, 0, 0.3, 16), closed: true }], median: [2.6], level: [0] };
    const a = hill(0, 0, 2.6, 1); // one ring of 50 m radius: 314 m of contour
    const { result: v } = vote([a, lone]);
    expect(v.evidenceM[1]).toBeLessThan(300);
    expect(v.label[1]).toBe(-1);
  });

  it("keeps a ladder at the wrap on continuous levels", () => {
    const a = hill(0, 0, 4.95, 10, 0, 0.12, 9);
    const { median, result: v } = vote([a]);
    expect(v.ladders).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      expect(Math.round((median[i] - v.phase[i]) / I) + 0).toBe(a.level[i]);
    }
  });

  it("is deterministic", () => {
    const mk = () => vote([hill(0, 0, 2.6, 8, 0, 0.3, 4), hill(1.5 * KM, 0, 0.4, 8, 2, 0.3, 5)]).result;
    expect(mk()).toEqual(mk());
  });
});

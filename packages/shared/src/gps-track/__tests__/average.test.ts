/** Averaging several passes (docs/map-gps-tracks.md §4). */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paperToWgs84, type PaperFrame } from "../../geo/projection.js";
import { readOmap } from "../../import/omap-reader.js";
import { omapToDocumentInput } from "../../import/omap-source.js";
import { averageTracks, unitNormals, type AverageResult } from "../average.js";
import { pointSegmentDistance } from "../geometry.js";
import { projectTrack, unprojectTrack, type ProjectedTrack } from "../project.js";
import { quantiseDeg, trackLength, type Track } from "../track.js";

/** 1:10 000 — 10 ground metres per paper mm. */
const M_PER_MM = 10;

/** A projected line from points in ground metres. */
function m(pts: [number, number][], metresPerMm = M_PER_MM): ProjectedTrack {
  return { x: Float64Array.from(pts.map((p) => p[0] / metresPerMm)), y: Float64Array.from(pts.map((p) => p[1] / metresPerMm)), metresPerMm };
}

/** A polyline through the corners, a point every `stepM` ground metres along it (corners kept). */
function densify(corners: [number, number][], stepM = 1): [number, number][] {
  const out: [number, number][] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1], [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepM));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

function shift(pts: [number, number][], dx: number, dy: number): [number, number][] {
  return pts.map(([x, y]) => [x + dx, y + dy]);
}

function reverse(l: ProjectedTrack): ProjectedTrack {
  return { x: Float64Array.from(l.x).reverse(), y: Float64Array.from(l.y).reverse(), metresPerMm: l.metresPerMm };
}

/** The result's samples in ground metres. */
function samples(r: AverageResult): [number, number][] {
  return Array.from(r.line.x, (x, i) => [x * M_PER_MM, r.line.y[i] * M_PER_MM]);
}

/** Distance in ground metres from a point (m) to a polyline (m). */
function distTo(p: [number, number], pts: [number, number][]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, pointSegmentDistance(p[0], p[1], pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return d;
}

/** A seeded LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A gently curving track (y = 20 sin(x / 40)), fixes every ~3 m with ±1.5 m of noise, from x0 to x1 m. */
function noisyPass(seed: number, x0: number, x1: number, bias: number): ProjectedTrack {
  const r = lcg(seed);
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x += 3) pts.push([x + (r() - 0.5) * 2, 20 * Math.sin(x / 40) + bias + (r() - 0.5) * 3]);
  return m(pts);
}

function bytes(a: Float64Array): number[] {
  return Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("averageTracks: input", () => {
  const a = m([[0, 0], [100, 0]]), b = m([[0, 4], [100, 4]]);

  it("rejects fewer than two passes, degenerate passes, mixed scales and bad options", () => {
    expect(() => averageTracks([])).toThrow(RangeError);
    expect(() => averageTracks([a])).toThrow(RangeError);
    expect(() => averageTracks([a, m([[5, 5], [5, 5], [5, 5]])])).toThrow(RangeError);
    expect(() => averageTracks([a, m([[0, 4], [100, 4]], 15)])).toThrow(RangeError);
    for (const opts of [{ stepM: 0 }, { stepM: -1 }, { stepM: Infinity }, { maxDistanceM: 0 }, { maxDistanceM: NaN }, { iterations: 0 }, { iterations: 1.5 }]) {
      expect(() => averageTracks([a, b], opts)).toThrow(RangeError);
    }
  });

  it("does not mutate its inputs and gives the same bytes twice", () => {
    const p = [noisyPass(1, 0, 300, 0), noisyPass(2, 0, 300, 2), noisyPass(3, 0, 300, -1)];
    const copies = p.map((l) => ({ x: Float64Array.from(l.x), y: Float64Array.from(l.y), metresPerMm: l.metresPerMm }));
    const r1 = averageTracks(p), r2 = averageTracks(p);
    expect(p).toEqual(copies);
    expect(bytes(r1.line.x)).toEqual(bytes(r2.line.x));
    expect(bytes(r1.line.y)).toEqual(bytes(r2.line.y));
    expect(r1.line.metresPerMm).toBe(M_PER_MM);
  });
});

describe("averageTracks: the reference (§4.2)", () => {
  const len = (l: number, y = 0) => m([[0, y], [l, y]]);

  it("is the upper median by length: the longer of two, the middle of three, the third of four", () => {
    expect(averageTracks([len(100), len(200, 2)]).reference).toBe(1);
    expect(averageTracks([len(200, 2), len(100)]).reference).toBe(0);
    expect(averageTracks([len(150, 1), len(200, 2), len(100)]).reference).toBe(0);
    expect(averageTracks([len(130, 3), len(150, 1), len(200, 2), len(100)]).reference).toBe(1);
  });

  it("ties on length go to the lexicographically smallest canonical point list, whatever the order", () => {
    const low = m([[0, 0], [100, 0]]), high = m([[0, 4], [100, 4]]);
    expect(averageTracks([high, low]).reference).toBe(1);
    expect(averageTracks([low, high]).reference).toBe(0);
    // Reversed, the low line is still the smaller list: its canonical direction starts at (0, 0).
    expect(averageTracks([high, reverse(low)]).reference).toBe(1);
    // Of three, the two of the median length tie; the shorter third takes no part.
    expect(averageTracks([high, m([[0, 2], [50, 2]]), low]).reference).toBe(2);
  });
});

describe("averageTracks: orientation (§4.3)", () => {
  const ref = m([[0, 0], [100, 0]]);

  it("a pass matching equally both ways is orientated by the ends rule: reversed when that brings its ends strictly nearer", () => {
    // A crossing at x = 30 matches the same samples either way round (its nearest point is the crossing).
    // Ends 36.1 + 70.7 m given, 31.6 + 72.8 m reversed: reversed.
    expect(averageTracks([ref, m([[30, -20], [30, 10]])]).reversed).toEqual([false, true]);
    // Ends 31.6 + 72.8 m given, 36.1 + 70.7 m reversed: kept.
    expect(averageTracks([ref, m([[30, -10], [30, 20]])]).reversed).toEqual([false, false]);
  });

  it("evidence wins over the ends rule", () => {
    // A parallel pass 4 m off, given the other way round and in its canonical direction: matched votes decide.
    const r = averageTracks([ref, m(densify([[100, 4], [0, 4]], 2))]);
    expect(r.reversed).toEqual([false, true]);
    expect(r.singlePass).toEqual([]);
  });
});

describe("unitNormals (§4.4)", () => {
  it("is left of travel, one-sided at the ends, the bisector at a corner, and falls back at a hairpin", () => {
    const n = unitNormals(m([[0, 0], [2, 0], [4, 0]]));
    expect([n.nx[0], n.ny[0], n.nx[1], n.ny[1], n.nx[2], n.ny[2]]).toEqual([-0, 1, -0, 1, -0, 1]);
    const c = unitNormals(m([[0, 0], [2, 0], [2, 2]]));
    expect(c.nx[1]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(c.ny[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect([c.nx[2], c.ny[2]]).toEqual([-1, 0]);
    // An exact hairpin: the central difference is zero, so the forward one is used.
    const h = unitNormals(m([[0, 0], [2, 0], [0, 0]]));
    expect([h.nx[1] + 0, h.ny[1]]).toEqual([0, -1]);
    expect([h.tx[1], h.ty[1]]).toEqual([-1, 0]);
  });
});

describe("averageTracks: two parallel passes give the centre line", () => {
  it("straight, 4 m apart", () => {
    const r = averageTracks([m(densify([[0, 0], [200, 0]], 5)), m(densify([[0, 4], [200, 4]], 3))]);
    expect(r.singlePass).toEqual([]);
    for (const [x, y] of samples(r)) {
      expect(Math.abs(y - 2)).toBeLessThan(1e-9);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(200 + 1e-9);
    }
    expect(samples(r).length).toBeGreaterThan(100);
  });

  it("concentric arcs of radius 100 and 104 m give radius 102", () => {
    const arc = (radius: number) => m(Array.from({ length: 181 }, (_, i) => {
      const a = (i / 180) * (Math.PI / 2);
      return [radius * Math.cos(a), radius * Math.sin(a)] as [number, number];
    }));
    const r = averageTracks([arc(100), arc(104)]);
    expect(r.singlePass).toEqual([]);
    for (const [x, y] of samples(r)) expect(Math.abs(Math.hypot(x, y) - 102)).toBeLessThan(0.02);
  });
});

describe("averageTracks: an outlier is ignored", () => {
  const A = densify([[0, 0], [200, 0]], 2);
  const B = densify([[0, 2], [200, 2]], 2);
  /** At y = 1 with an excursion to `peak` m between x = 80 and 120. */
  const excursion = (peak: number, x0 = 0, x1 = 200) => densify([[x0, 1], [70, 1], [80, peak], [120, peak], [130, 1], [x1, 1]], 2);

  it("an excursion within the gate does not pull the line out of the band of the two good passes", () => {
    const r = averageTracks([m(A), m(B), m(excursion(10))]);
    expect(r.singlePass).toEqual([]);
    for (const [, y] of samples(r)) {
      expect(y).toBeGreaterThan(-1e-9);
      expect(y).toBeLessThan(2 + 1e-9);
    }
  });

  it("likewise when the outlier is the median-length reference", () => {
    const shortA = densify([[10, 0], [190, 0]], 2), longB = densify([[0, 2], [220, 2]], 2);
    const passes = [m(shortA), m(longB), m(excursion(8))];
    const r = averageTracks(passes);
    expect(r.reference).toBe(2);
    // On the plateau the line is the good pass nearer the outlier, exactly; on the outlier's slopes,
    // moving along a tilted normal by a normal offset overshoots the band by a few decimetres at most.
    for (const [x, y] of samples(r)) {
      if (x > 85 && x < 115) expect(Math.abs(y - 2)).toBeLessThan(1e-9);
      expect(y).toBeGreaterThan(-0.25);
      expect(y).toBeLessThan(2.25);
    }
  });

  it("a pass beyond the gate gives no votes: the two near passes average", () => {
    const far = densify([[0, 1], [70, 1], [80, 30], [120, 30], [130, 1], [200, 1]], 2);
    const r = averageTracks([m(A), m(B), m(far)]);
    for (const [x, y] of samples(r)) {
      // Its slopes come within 15 m of the samples up to about x = 86 and from 114 on.
      if (x > 90 && x < 110) expect(Math.abs(y - 1)).toBeLessThan(1e-9);
    }
  });
});

describe("averageTracks: reversal and input order (§4.2)", () => {
  it("any order and any pass reversed give the same bytes", () => {
    const passes = [noisyPass(11, -20, 400, 0), noisyPass(12, 5, 420, 2), noisyPass(13, 0, 380, -1.5)];
    const base = averageTracks(passes);
    expect(base.singlePass.length).toBeGreaterThan(0); // the overhangs
    const refPass = passes[base.reference];
    for (const order of permutations([0, 1, 2])) {
      for (let mask = 0; mask < 8; mask++) {
        const input = order.map((i, k) => ((mask >> k) & 1 ? reverse(passes[i]) : passes[i]));
        const r = averageTracks(input);
        expect(bytes(r.line.x)).toEqual(bytes(base.line.x));
        expect(bytes(r.line.y)).toEqual(bytes(base.line.y));
        expect(r.singlePass).toEqual(base.singlePass);
        expect(order[r.reference]).toBe(passes.indexOf(refPass));
        order.forEach((i, k) => expect(r.reversed[k]).toBe(base.reversed[i] !== Boolean((mask >> k) & 1)));
      }
    }
  });
});

describe("averageTracks: partial coverage (§4.5–4.6)", () => {
  const full = densify([[0, 0], [200, 0]], 1);

  it("a pass covering half: the other half is reported single-pass and stays on the reference", () => {
    for (const half of [densify([[100, 2], [200, 2]], 1), densify([[200, 2], [100, 2]], 1)]) {
      const r = averageTracks([m(full), m(half)]);
      expect(r.reference).toBe(0);
      expect(r.singlePass).toHaveLength(1);
      const [{ start, end }] = r.singlePass;
      const s = samples(r);
      expect(start).toBe(0);
      // The range ends where the half begins: within one 2 m step (the end rule).
      expect(s[end - 1][0]).toBeLessThan(100);
      expect(s[end - 1][0]).toBeGreaterThan(95);
      expect(s[end][0]).toBeGreaterThanOrEqual(97);
      // A lone vote moves the sample onto that pass: the single-pass stretch lies on the full pass
      // (within a few cm on the short step where the half begins).
      for (let i = 0; i < end; i++) expect(Math.abs(s[i][1])).toBeLessThan(s[i][0] < 90 ? 1e-12 : 0.05);
      for (const [x, y] of s) if (x > 102) expect(Math.abs(y - 1)).toBeLessThan(1e-9);
    }
  });

  it("a pass that leaves for a while is reported there and matched again after", () => {
    // Its departing and returning slopes stay within 15 m of the line for ~15 m and vote there (§4.6).
    const detour = densify([[0, 2], [80, 2], [90, 40], [120, 40], [130, 2], [200, 2]], 1);
    // The straight pass is the longer one, so it is the reference; its overhangs are single-pass too.
    const long = densify([[-40, 0], [240, 0]], 1);
    const r = averageTracks([m(long), m(detour)]);
    const s = samples(r);
    expect(r.reference).toBe(0);
    expect(r.singlePass).toHaveLength(3);
    expect(s[r.singlePass[0].end][0]).toBeGreaterThan(-3);
    expect(s[r.singlePass[2].start - 1][0]).toBeLessThan(203);
    const { start, end } = r.singlePass[1];
    // The slopes are within 15 m of the line until x ≈ 95 and again from x ≈ 115.
    expect(s[start][0]).toBeGreaterThan(90);
    expect(s[start][0]).toBeLessThan(100);
    expect(s[end - 1][0]).toBeGreaterThan(110);
    expect(s[end - 1][0]).toBeLessThan(120);
    for (let i = start; i < end; i++) expect(Math.abs(s[i][1])).toBeLessThan(s[i][0] > 97 && s[i][0] < 113 ? 1e-12 : 0.05);
    for (const [x, y] of s) if ((x > 5 && x < 65) || (x > 145 && x < 195)) expect(Math.abs(y - 1)).toBeLessThan(1e-9);
  });
});

describe("averageTracks: loops (§4.3, §4.5)", () => {
  it("a loop that passes itself does not cross-match at the crossing", () => {
    // East, north, west, then south across the first leg at (100, 0).
    const R = densify([[0, 0], [200, 0], [200, 100], [100, 100], [100, -100]], 2);
    // 3 m south and 1 m east: at the crossing the second visit (1 m) is nearer than the first (3 m).
    const B = shift(densify([[0, 0], [200, 0], [200, 100], [100, 100], [100, -100]], 3), 1, -3);
    const r = averageTracks([m(R), m(B)]);
    expect(r.singlePass).toEqual([]);
    const mid = shift(densify([[0, 0], [200, 0], [200, 100], [100, 100], [100, -100]], 1), 0.5, -1.5);
    const corners: [number, number][] = [[200, 0], [200, 100], [100, 100]];
    for (const p of samples(r)) {
      if (corners.some(([cx, cy]) => Math.hypot(p[0] - cx, p[1] - cy) < 10)) continue;
      if (Math.hypot(p[0], p[1]) < 5 || Math.hypot(p[0] - 100, p[1] + 100) < 5) continue; // the offset ends
      expect(distTo(p, mid)).toBeLessThan(1e-6);
    }
  });

  it("a closed loop skied the other way round is orientated by its matches", () => {
    // A 100 m square from the middle of its west side, southward first.
    const R = densify([[0, 50], [0, 0], [100, 0], [100, 100], [0, 100], [0, 50]], 2);
    // 2 m inside, starting at the same place but northward, with a jog that makes its canonical direction northward too.
    const B = densify([[2, 50], [1.5, 51], [2, 52], [2, 98], [98, 98], [98, 2], [2, 2], [2, 48], [2.5, 49], [2, 50]], 2);
    const r = averageTracks([m(R), m(B)]);
    expect(r.singlePass).toEqual([]);
    const mid = densify([[1, 50], [1, 1], [99, 1], [99, 99], [1, 99], [1, 50]], 1);
    for (const p of samples(r)) {
      if (Math.hypot(p[0], p[1] - 50) < 8) continue; // the jogs at the start
      if ([[0, 0], [100, 0], [100, 100], [0, 100]].some(([cx, cy]) => Math.hypot(p[0] - cx, p[1] - cy) < 8)) continue;
      expect(distTo(p, mid)).toBeLessThan(1e-6);
    }
  });
});

describe("averageTracks: iterations (§4.6)", () => {
  it("the second iteration matches every pass against the first result", () => {
    const passes = [noisyPass(21, 0, 300, 0), noisyPass(22, 0, 300, 1.5)];
    const one = averageTracks(passes, { iterations: 1 }), two = averageTracks(passes), three = averageTracks(passes, { iterations: 3 });
    expect(bytes(one.line.y)).not.toEqual(bytes(two.line.y));
    expect(bytes(two.line.y)).not.toEqual(bytes(three.line.y));
    for (const r of [one, two, three]) for (const { start, end } of r.singlePass) {
      expect(start).toBeLessThan(end);
      expect(end).toBeLessThanOrEqual(r.line.x.length);
    }
  });

  it("ranges are ascending, disjoint and never touching", () => {
    const full = densify([[0, 0], [300, 0]], 1);
    const holes = densify([[0, 2], [50, 2], [60, 40], [90, 40], [100, 2], [180, 2], [190, 40], [220, 40], [230, 2], [300, 2]], 1);
    const r = averageTracks([m(full), m(holes)]);
    expect(r.singlePass).toHaveLength(2);
    expect(r.singlePass[0].end).toBeLessThan(r.singlePass[1].start);
  });
});

describe("averageTracks: storage (§4.1)", () => {
  const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../e2e/test.xmap");
  const { header } = omapToDocumentInput(readOmap(readFileSync(FIXTURE, "utf8")), { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 1 }).input;
  const xmap: PaperFrame = { unitsPerMm: header.unitsPerMm, mapScale: header.mapScale, georeferencing: header.georeferencing };

  function trackAt(mm: [number, number][]): Track {
    const pts = mm.map(([x, y]) => paperToWgs84(xmap, x * xmap.unitsPerMm, y * xmap.unitsPerMm)!);
    return { name: null, points: { lat: pts.map((p) => quantiseDeg(p.lat)), lng: pts.map((p) => quantiseDeg(p.lng)), time: null, ele: null } };
  }

  it("projected passes average to a line that unprojects index-aligned, so the ranges index the stored track", () => {
    const a = trackAt(densify([[0, 0], [20, 0]], 0.2)), b = trackAt(densify([[10, 0.4], [20, 0.4]], 0.2));
    const r = averageTracks([projectTrack(xmap, a).track, projectTrack(xmap, b).track]);
    const stored = unprojectTrack(xmap, r.line, "average");
    expect(trackLength(stored)).toBe(r.line.x.length);
    expect(r.singlePass).toHaveLength(1);
    expect(r.singlePass[0].end).toBeLessThan(trackLength(stored));
    const back = projectTrack(xmap, stored).track;
    const last = back.x.length - 1;
    expect(Math.abs(back.y[last] - 0.2)).toBeLessThan(0.002);
  });
});

describe("averageTracks: size", () => {
  it(
    "three 10 km passes at a fix per metre, one covering half",
    () => {
      const r1 = lcg(7);
      const pass = (x0: number, x1: number, bias: number) => {
        const pts: [number, number][] = [];
        for (let x = x0; x <= x1; x += 1) pts.push([x, 50 * Math.sin(x / 300) + bias + (r1() - 0.5) * 2]);
        return m(pts);
      };
      const r = averageTracks([pass(0, 10000, 0), pass(0, 10000, 2), pass(5000, 10000, 1)]);
      expect(r.line.x.length).toBeGreaterThan(5000);
    },
    20_000,
  );
});

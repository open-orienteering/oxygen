/**
 * Averaging several passes of one track into one line
 * (docs/map-gps-tracks.md §4; SLICES.md slice G "Decided in this split",
 * "Averaging", with the user's refinements of 2026-11-13). Pure and
 * deterministic: only + − × ÷ and √ (correctly rounded by IEEE 754) in a
 * fixed order, numeric sorts, no randomness, inputs never mutated — the
 * same projected passes give the same bytes on every engine.
 */

import { DEFAULT_STEP_M, resampleTrack } from "./geometry.js";
import type { ProjectedTrack } from "./project.js";
import type { TrackRange } from "./track.js";

export const DEFAULT_MATCH_DISTANCE_M = 15;
export const DEFAULT_ITERATIONS = 2;

export interface AverageOptions {
  /** Resampling step of the reference, ground metres. Default 2. */
  stepM?: number;
  /** A pass votes on a sample only from within this distance, ground metres. Default 15. */
  maxDistanceM?: number;
  /** Integer ≥ 1. Default 2: the fixed method's "repeat once". */
  iterations?: number;
}

export interface AverageResult {
  /** The moved samples of the last iteration, about `stepM` apart, in the reference's canonical direction. */
  line: ProjectedTrack;
  /** Point indices of `line`, `[start, end)`, ascending, disjoint, never touching: samples fewer than two passes voted on. */
  singlePass: TrackRange[];
  /** Index in the input of the pass chosen as the reference. */
  reference: number;
}

/** A plain polyline in paper mm (no consecutive duplicates once canonical). */
interface Line {
  x: Float64Array;
  y: Float64Array;
}

/** Tangents and left normals of a line, unit length (zero for a line with no extent). */
export interface Normals {
  tx: Float64Array;
  ty: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
}

function dedupe(line: ProjectedTrack): Line {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < line.x.length; i++) {
    const n = x.length;
    if (n > 0 && x[n - 1] === line.x[i] && y[n - 1] === line.y[i]) continue;
    x.push(line.x[i]);
    y.push(line.y[i]);
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

function reversed(l: Line): Line {
  return { x: Float64Array.from(l.x).reverse(), y: Float64Array.from(l.y).reverse() };
}

/** Lexicographic over x₀, y₀, x₁, y₁, …; a shorter list first on a common prefix. */
function compareLists(a: Line, b: Line): number {
  const n = Math.min(a.x.length, b.x.length);
  for (let i = 0; i < n; i++) {
    if (a.x[i] !== b.x[i]) return a.x[i] < b.x[i] ? -1 : 1;
    if (a.y[i] !== b.y[i]) return a.y[i] < b.y[i] ? -1 : 1;
  }
  return a.x.length - b.x.length;
}

/** The pass or its reverse, whichever point list is lexicographically smaller (§4.2 step 0). */
function canonical(l: Line): Line {
  const r = reversed(l);
  return compareLists(r, l) < 0 ? r : l;
}

function lengthOf(l: Line): number {
  let s = 0;
  for (let i = 1; i < l.x.length; i++) {
    const dx = l.x[i] - l.x[i - 1], dy = l.y[i] - l.y[i - 1];
    s += Math.sqrt(dx * dx + dy * dy);
  }
  return s;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Unit tangent and left normal (−tᵧ, tₓ) at each point (§4.4): the
 * central difference inside, one-sided at the ends; a zero central
 * difference (an exact hairpin) falls back to the forward, then the
 * backward difference.
 */
export function unitNormals(line: ProjectedTrack): Normals {
  const { x, y } = line;
  const n = x.length;
  const tx = new Float64Array(n), ty = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const candidates: [number, number][] = [];
    if (i > 0 && i < n - 1) candidates.push([i - 1, i + 1]);
    if (i < n - 1) candidates.push([i, i + 1]);
    if (i > 0) candidates.push([i - 1, i]);
    for (const [a, b] of candidates) {
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        tx[i] = dx / len;
        ty[i] = dy / len;
        nx[i] = -ty[i];
        ny[i] = tx[i];
        break;
      }
    }
  }
  return { tx, ty, nx, ny };
}

/**
 * One pass's votes on the reference's samples (§4.5): NaN where it does
 * not vote. Monotone along the pass; the match is the nearest point in
 * the first run of consecutive segments within the gate; a match at the
 * pass's first or last point counts only within one step along the
 * tangent.
 */
function matchPass(ref: Line, nrm: Normals, pass: Line, gateMm: number, stepMm: number): Float64Array {
  const votes = new Float64Array(ref.x.length).fill(NaN);
  const { x, y } = pass;
  const segs = x.length - 1;
  const gate2 = gateMm * gateMm;
  let k = 0, t0 = 0; // the previous match: segment k at parameter t0
  for (let i = 0; i < ref.x.length; i++) {
    const px = ref.x[i], py = ref.y[i];
    let best = Infinity, bk = -1, bt = 0, inRun = false;
    for (let j = k; j < segs; j++) {
      const ax = x[j], ay = y[j], dx = x[j + 1] - ax, dy = y[j + 1] - ay;
      const len2 = dx * dx + dy * dy;
      const lo = j === k ? t0 : 0;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < lo ? lo : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 <= gate2) {
        inRun = true;
        if (d2 < best) {
          best = d2;
          bk = j;
          bt = t;
        }
      } else if (inRun) break;
    }
    if (bk < 0) continue;
    const qx = x[bk] + bt * (x[bk + 1] - x[bk]), qy = y[bk] + bt * (y[bk + 1] - y[bk]);
    const ox = qx - px, oy = qy - py;
    if ((bk === 0 && bt === 0) || (bk === segs - 1 && bt === 1)) {
      const along = ox * nrm.tx[i] + oy * nrm.ty[i];
      if (along > stepMm || along < -stepMm) continue;
    }
    votes[i] = ox * nrm.nx[i] + oy * nrm.ny[i];
    k = bk;
    t0 = bt;
  }
  return votes;
}

function voteCount(v: Float64Array): number {
  let c = 0;
  for (let i = 0; i < v.length; i++) if (v[i] === v[i]) c++;
  return c;
}

/** Moves each sample by the median of its votes (§4.6); a sample without votes stays. */
function applyVotes(ref: Line, nrm: Normals, votes: Float64Array[], counts: Uint32Array): Line {
  const n = ref.x.length;
  const ox = Float64Array.from(ref.x), oy = Float64Array.from(ref.y);
  const buf = new Float64Array(votes.length);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (const v of votes) if (v[i] === v[i]) buf[c++] = v[i];
    counts[i] = c;
    if (c === 0) continue;
    const s = buf.subarray(0, c).sort();
    const med = c % 2 === 1 ? s[(c - 1) / 2] : (s[c / 2 - 1] + s[c / 2]) / 2;
    ox[i] = ref.x[i] + med * nrm.nx[i];
    oy[i] = ref.y[i] + med * nrm.ny[i];
  }
  return { x: ox, y: oy };
}

function ranges(counts: Uint32Array): TrackRange[] {
  const out: TrackRange[] = [];
  let start = -1;
  for (let i = 0; i <= counts.length; i++) {
    const single = i < counts.length && counts[i] < 2;
    if (single && start < 0) start = i;
    if (!single && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  return out;
}

function positiveFinite(v: number, what: string): number {
  if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`${what} must be positive and finite (got ${v})`);
  return v;
}

/**
 * Average several projected passes of one track (§4): canonical
 * direction, the upper-median-length pass as reference, the others
 * orientated by their matches, the reference resampled every `stepM`
 * with unit normals, monotone matching within `maxDistanceM`, each
 * sample moved by the median of the votes; `iterations` times, each
 * later iteration with the previous result as the reference.
 */
export function averageTracks(passes: readonly ProjectedTrack[], opts: AverageOptions = {}): AverageResult {
  const stepM = positiveFinite(opts.stepM ?? DEFAULT_STEP_M, "Resampling step");
  const gateM = positiveFinite(opts.maxDistanceM ?? DEFAULT_MATCH_DISTANCE_M, "Match distance");
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError(`Iterations must be an integer ≥ 1 (got ${iterations})`);
  if (passes.length < 2) throw new RangeError(`Averaging needs at least two passes (got ${passes.length})`);
  const metresPerMm = passes[0].metresPerMm;
  if (passes.some((p) => p.metresPerMm !== metresPerMm)) throw new RangeError("All passes must be projected onto the same map scale");
  const stepMm = stepM / metresPerMm, gateMm = gateM / metresPerMm;

  // §4.2 step 0: canonical direction.
  const lines = passes.map((p, i) => {
    const d = dedupe(p);
    if (d.x.length < 2) throw new RangeError(`Pass ${i} has fewer than two distinct points`);
    return canonical(d);
  });

  // §4.2 step 1: the upper median length; of the passes that long, the smallest canonical point list.
  const lengths = lines.map(lengthOf);
  const median = Float64Array.from(lengths).sort()[Math.floor(lengths.length / 2)];
  let reference = -1;
  lines.forEach((line, i) => {
    if (lengths[i] === median && (reference < 0 || compareLists(line, lines[reference]) < 0)) reference = i;
  });
  const refLine = lines[reference];

  // §4.4: the reference resampled, with normals.
  let ref: Line = resampleTrack({ ...refLine, metresPerMm }, stepM);
  let nrm = unitNormals({ ...ref, metresPerMm });

  // §4.3 step 2: each other pass orientated by evidence, the ends rule breaking ties.
  const r0x = refLine.x[0], r0y = refLine.y[0], rnx = refLine.x[refLine.x.length - 1], rny = refLine.y[refLine.y.length - 1];
  const oriented: Line[] = [];
  const firstVotes: Float64Array[] = [];
  lines.forEach((line, i) => {
    if (i === reference) {
      oriented.push(line);
      return;
    }
    const back = reversed(line);
    const vf = matchPass(ref, nrm, line, gateMm, stepMm), vb = matchPass(ref, nrm, back, gateMm, stepMm);
    const cf = voteCount(vf), cb = voteCount(vb);
    let useBack = cb > cf;
    if (cb === cf) {
      const last = line.x.length - 1;
      const same = dist(line.x[0], line.y[0], r0x, r0y) + dist(line.x[last], line.y[last], rnx, rny);
      const swapped = dist(line.x[last], line.y[last], r0x, r0y) + dist(line.x[0], line.y[0], rnx, rny);
      useBack = swapped < same;
    }
    oriented.push(useBack ? back : line);
    firstVotes.push(useBack ? vb : vf);
  });

  // §4.6 step 5, first iteration: the reference votes 0 everywhere.
  let counts = new Uint32Array(ref.x.length);
  let result = applyVotes(ref, nrm, [new Float64Array(ref.x.length), ...firstVotes], counts);

  // §4.6 step 6: later iterations against the previous result; every pass votes, the result does not.
  for (let it = 1; it < iterations; it++) {
    ref = resampleTrack({ ...result, metresPerMm }, stepM);
    nrm = unitNormals({ ...ref, metresPerMm });
    const votes = oriented.map((p) => matchPass(ref, nrm, p, gateMm, stepMm));
    counts = new Uint32Array(ref.x.length);
    result = applyVotes(ref, nrm, votes, counts);
  }

  return { line: { x: result.x, y: result.y, metresPerMm }, singlePass: ranges(counts), reference };
}

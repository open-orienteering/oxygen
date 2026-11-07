/**
 * Corridor geometry (docs/course-layer.md §10.2; research 08 §4.3).
 *
 * A corridor is its leg's polyline (bends included) buffered to half its
 * width: the map shows inside. The white band is the polyline buffered
 * `whiteMm` further, less the inside. Corridors are joined by a true
 * union — over consecutive legs, sites, a change of width and every drawn
 * course — so nothing of one corridor's band lies inside another.
 *
 * The pass stream fills and clips even-odd only (map-rendering.md §3.1),
 * and even-odd over overlapping pieces cuts a hole at every join, so the
 * buffers are built as unions of convex pieces (a rectangle per segment,
 * a disc per vertex: the exact round-joined buffer) with polygon-clipping.
 * The output rings are simple and properly nested; even-odd draws them as
 * the union and the difference they are.
 */

import * as polygonClippingModule from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import type { FlatRing } from "../render/geometry.js";
import type { DerivedCourse } from "./types.js";

// Both the CJS and the ESM build export only `default`; the bundled d.ts declares named exports.
const pc = (polygonClippingModule as unknown as { default: typeof polygonClippingModule }).default;

/** Flattening tolerance of the discs, µm: the stream's (map-rendering.md §3.1). */
const TOLERANCE_UM = 5;
/** A boundary point belongs to an edged leg's side when its distance from the leg is half the width ± this, µm. */
const EDGE_TOLERANCE_UM = 20;
/** Sampling step along the inside's boundary when finding the edged parts, µm. */
const EDGE_STEP_UM = 50;

interface Pt {
  x: number;
  y: number;
}

/** An edge piece: part of the inside's boundary along edged legs, µm. */
export interface CorridorEdge {
  points: Pt[];
  closed: boolean;
  /** `<courseId>:<leg index>` of the leg it runs along (its first sample's). */
  ref: string;
}

export interface CorridorGeometry {
  /** Rings of the union of every corridor's inside, µm (outer rings and holes; even-odd). */
  inside: FlatRing[];
  /** Rings of the white band (∪ outer) − (∪ inside), µm; `null` when no corridor has a band. */
  band: FlatRing[] | null;
  edges: CorridorEdge[];
}

interface Run {
  pts: Pt[];
  /** Half the width, µm. */
  half: number;
  white: number;
}

interface EdgedSegment {
  a: Pt;
  b: Pt;
  half: number;
  ref: string;
  /** Whether the round end at `a` / `b` is this leg's: no unedged corridor leg meets it there. */
  capA: boolean;
  capB: boolean;
  /** Bounds grown by the half width and the tolerance: the cheap reject before the distance. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const round = (p: { x: number; y: number }): Pt => ({ x: Math.round(p.x * 1000), y: Math.round(p.y * 1000) });

/** Drops repeated points and straight-through interior points (a reversal stays). */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = last!;
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (cross === 0 && dot > 0) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Runs of consecutive corridor legs of equal width and band, per course. */
function runsOf(courses: readonly DerivedCourse[]): { runs: Run[]; edged: EdgedSegment[] } {
  const runs: Run[] = [];
  const edged: Omit<EdgedSegment, "capA" | "capB">[] = [];
  /** Vertices an unedged corridor leg runs from or to: an edged leg's round end there is shared, not drawn. */
  const unedged = new Set<string>();
  const key = (p: Pt) => `${p.x} ${p.y}`;
  for (const c of courses) {
    let run: Run | null = null;
    c.legs.forEach((leg, i) => {
      const k = leg.corridor;
      if (!k || leg.points.length < 2) {
        run = null;
        return;
      }
      const pts = leg.points.map(round);
      const half = (k.widthMm * 1000) / 2, white = k.whiteMm * 1000;
      if (run && run.half === half && run.white === white) run.pts.push(...pts);
      else {
        run = { pts: [...pts], half, white };
        runs.push(run);
      }
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1], b = pts[j];
        if (!k.edge) {
          unedged.add(key(a));
          unedged.add(key(b));
          continue;
        }
        const g = half + EDGE_TOLERANCE_UM;
        edged.push({ a, b, half, ref: `${c.id}:${i}`, minX: Math.min(a.x, b.x) - g, minY: Math.min(a.y, b.y) - g, maxX: Math.max(a.x, b.x) + g, maxY: Math.max(a.y, b.y) + g });
      }
    });
  }
  for (const r of runs) r.pts = simplify(r.pts);
  return { runs, edged: edged.map((e) => ({ ...e, capA: !unedged.has(key(e.a)), capB: !unedged.has(key(e.b)) })) };
}

function disc(c: Pt, h: number): Polygon {
  const n = Math.max(8, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(-1, 1 - TOLERANCE_UM / h)))));
  const ring: [number, number][] = [];
  for (let k = 0; k < n; k++) ring.push([c.x + h * Math.cos((2 * Math.PI * k) / n), c.y + h * Math.sin((2 * Math.PI * k) / n)]);
  ring.push(ring[0]);
  return [ring];
}

function rect(a: Pt, b: Pt, h: number): Polygon {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  const nx = (-(b.y - a.y) / l) * h, ny = ((b.x - a.x) / l) * h;
  return [[[a.x - nx, a.y - ny], [b.x - nx, b.y - ny], [b.x + nx, b.y + ny], [a.x + nx, a.y + ny], [a.x - nx, a.y - ny]]];
}

/** The round-joined buffer of every run at its half width plus `extra(run)`, as one union. */
function buffer(runs: readonly Run[], extra: (r: Run) => number): MultiPolygon {
  const pieces = new Map<string, Polygon>();
  for (const r of runs) {
    const h = r.half + extra(r);
    if (h <= 0) continue;
    for (const p of r.pts) pieces.set(`d ${p.x} ${p.y} ${h}`, disc(p, h));
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const [s, t] = a.x < b.x || (a.x === b.x && a.y < b.y) ? [a, b] : [b, a];
      pieces.set(`r ${s.x} ${s.y} ${t.x} ${t.y} ${h}`, rect(s, t, h));
    }
  }
  const all = [...pieces.values()];
  return all.length ? pc.union(all[0], ...all.slice(1)) : [];
}

/** polygon-clipping rings (closed, float) → flat integer-µm rings, the closing point dropped. */
function flat(mp: MultiPolygon): FlatRing[] {
  const out: FlatRing[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      const r: number[] = [];
      for (const [x, y] of ring.slice(0, -1)) {
        const px = Math.round(x), py = Math.round(y);
        if (r.length && r[r.length - 2] === px && r[r.length - 1] === py) continue;
        r.push(px, py);
      }
      if (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r.length -= 2;
      if (r.length >= 6) out.push(r);
    }
  }
  return out;
}

/**
 * Distance from `p` to segment `s`, or `Infinity` when the nearest point
 * is an end whose round end is not the segment's (`capA` / `capB` false:
 * an unedged corridor leg continues there, and the boundary past the
 * join is its side, course-layer.md §10.2).
 */
function distToEdged(p: Pt, s: EdgedSegment): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const l2 = dx * dx + dy * dy;
  const raw = l2 ? ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2 : 0;
  if ((raw < 0 && !s.capA) || (raw > 1 && !s.capB)) return Infinity;
  const t = Math.max(0, Math.min(1, raw));
  return Math.hypot(p.x - s.a.x - t * dx, p.y - s.a.y - t * dy);
}

/** The edged leg whose side `p` lies on, by ref; `null` when none. */
function edgedRefAt(p: Pt, edged: readonly EdgedSegment[]): string | null {
  for (const s of edged) {
    if (p.x < s.minX || p.x > s.maxX || p.y < s.minY || p.y > s.maxY) continue;
    if (Math.abs(distToEdged(p, s) - s.half) < EDGE_TOLERANCE_UM) return s.ref;
  }
  return null;
}

/** The parts of the inside's boundary rings that run along edged legs. */
function edgesOf(inside: FlatRing[], edged: readonly EdgedSegment[]): CorridorEdge[] {
  if (!edged.length) return [];
  const out: CorridorEdge[] = [];
  for (const ring of inside) {
    const n = ring.length / 2;
    // Samples around the ring: each a point and the ref of the piece from it to the next sample.
    const samples: { p: Pt; ref: string | null; vertex: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const a = { x: ring[2 * i], y: ring[2 * i + 1] };
      const b = { x: ring[(2 * i + 2) % ring.length], y: ring[(2 * i + 3) % ring.length] };
      const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / EDGE_STEP_UM));
      for (let j = 0; j < k; j++) {
        const t0 = j / k, tm = (j + 0.5) / k;
        const p = j === 0 ? a : { x: Math.round(a.x + (b.x - a.x) * t0), y: Math.round(a.y + (b.y - a.y) * t0) };
        const m = { x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm };
        samples.push({ p, ref: edgedRefAt(m, edged), vertex: j === 0 });
      }
    }
    if (samples.every((s) => s.ref !== null && s.ref === samples[0].ref)) {
      out.push({ points: ringPoints(ring), closed: true, ref: samples[0].ref! });
      continue;
    }
    // Start at a change so no piece wraps around the ring's first point; none = no edged part on this ring.
    const start = samples.findIndex((s, i) => s.ref !== samples[(i + samples.length - 1) % samples.length].ref);
    if (start < 0) continue;
    let cur: CorridorEdge | null = null;
    for (let k = 0; k <= samples.length; k++) {
      const s = samples[(start + k) % samples.length];
      if (cur && (k === samples.length || s.ref !== cur.ref)) {
        cur.points.push(s.p);
        if (cur.points.length >= 2) out.push(cur);
        cur = null;
      }
      if (k === samples.length) break;
      if (!cur && s.ref !== null) cur = { points: [s.p], closed: false, ref: s.ref };
      else if (cur && s.vertex) cur.points.push(s.p);
    }
  }
  return out;
}

const ringPoints = (r: FlatRing): Pt[] => Array.from({ length: r.length / 2 }, (_, i) => ({ x: r[2 * i], y: r[2 * i + 1] }));

/**
 * The corridors of the derived courses: the union of their insides, the
 * band outside them and the edged legs' outlines. `null` when no leg has
 * a corridor.
 */
export function corridorGeometry(courses: readonly DerivedCourse[]): CorridorGeometry | null {
  const { runs, edged } = runsOf(courses);
  if (!runs.length) return null;
  const insideMp = buffer(runs, () => 0);
  const inside = flat(insideMp);
  let band: FlatRing[] | null = null;
  const banded = runs.filter((r) => r.white > 0);
  if (banded.length) {
    const outer = buffer(banded, (r) => r.white);
    const rings = flat(pc.difference(outer, insideMp));
    if (rings.length) band = rings;
  }
  return { inside, band, edges: edgesOf(inside, edged) };
}

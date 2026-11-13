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
 * buffers are unioned with polygon-clipping, whose output rings are simple
 * and properly nested; even-odd draws them as the union and the difference
 * they are. Each run's buffer is one ring (F13, user answer 2026-11-08):
 * its nonzero winding is the round-joined buffer, which polygon-clipping
 * (nonzero per input ring) cleans — a rectangle per segment and a disc per
 * vertex cost too much, and crashed it, on a flattened curve.
 *
 * Mouths and openings (F19, the way Coursecraft draws it): every site a
 * corridor leg starts or ends at adds its symbol to the inside and the
 * band wraps it, so the edges end on the symbol; an edged leg narrower
 * than the circle opens the drawn circle where its sides meet it. The
 * openings are drawn, never cuts: the layer adds them to the circle at
 * draw time only.
 *
 * Ends (F22): where a corridor ends — a site with exactly one corridor-leg
 * end over every course, not a start — the band stops on the line through
 * the site across the leg, its corners rounded, and wraps only the near
 * half of the symbol; the inside, the edges and the openings are as before.
 */

import * as polygonClippingModule from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import type { FlatRing } from "../render/geometry.js";
import type { AngularGap } from "../course-maps/overlay-geometry.js";
import type { DerivedCourse, DerivedSite } from "./types.js";

// Both the CJS and the ESM build export only `default`; the bundled d.ts declares named exports.
const pc = (polygonClippingModule as unknown as { default: typeof polygonClippingModule }).default;

/** Flattening tolerance of the discs, µm: the stream's (map-rendering.md §3.1). */
const TOLERANCE_UM = 5;
/** A boundary point belongs to an edged leg's side when its distance from the leg is half the width ± this, µm. */
const EDGE_TOLERANCE_UM = 20;
/** Sampling step along the inside's boundary when finding the edged parts, µm. */
const EDGE_STEP_UM = 50;
/** A ring vertex lies on a mouth's outline within this, µm: 5 µm flattening plus integer rounding. */
const MOUTH_TOLERANCE_UM = 10;
/** A junction lies on the inside's boundary within this, µm (a covered one is hundreds of µm inside). */
const JUNCTION_TOLERANCE_UM = 20;

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
  /**
   * The drawn openings of control circles, by site id, compass degrees
   * (§10.2 "Openings", F19). Drawn only: never a `DerivedSite.cuts`
   * entry, never stored. Empty without `mouths`.
   */
  openings: Map<string, AngularGap[]>;
}

/** A drawn site as the mouths read it: `DerivedSite`'s position, role and 701 turn (mm, degrees). */
export type CorridorSite = Pick<DerivedSite, "id" | "role" | "x" | "y" | "angleDeg">;

/**
 * The sites the corridor legs end at, and the symbols' centre-line
 * extents (the layer's `CourseSymbolSet`): 703's radius R, 706's outer
 * ring, 701's circumradius.
 */
export interface CorridorMouths {
  sites: readonly CorridorSite[];
  circleUm: number;
  finishUm: number;
  startUm: number;
}

/** One end of a corridor leg at a site. */
interface LegEnd {
  siteId: string;
  /** The site's point (the leg's end), µm. */
  c: Pt;
  /** The leg's distinct points from the site on (`path[0]` is `c`), µm. */
  path: Pt[];
  half: number;
  white: number;
  edge: boolean;
}

/** A site where corridor legs end, drawn as a 703, 706 or 701 (§10.2 "Mouths"). */
interface Mouth {
  site: CorridorSite;
  c: Pt;
  /** The symbol's centre-line extent, µm: R, the outer ring's radius, the circumradius. */
  extent: number;
  /** The 701's corners (µm), counter-clockwise; absent for a disc. */
  corners?: Pt[];
  /** Whether the symbol joins the inside: no leg's round end at the site encloses it. */
  inInside: boolean;
}

interface Run {
  pts: Pt[];
  /** Each leg's points (µm), in order: the legs a terminal end's cut leaves alone (F22). */
  legs: Pt[][];
  /** Half the width, µm. */
  half: number;
  white: number;
  /** The sites the run starts and ends at (its first leg's `from`, its last leg's `to`). */
  from: string;
  to: string;
  /** Flat ends instead of round (F19): the run starts / ends at a start whose 701 joins the inside. */
  flatStart?: boolean;
  flatEnd?: boolean;
  /**
   * The outer ring's end at a terminal end (F22): flat on the site, its corners rounded by this radius, µm —
   * whiteMm, or h + whiteMm − R where the band reaches past the end's circle by less (one corner, no bump).
   */
  cornerStart?: number;
  cornerEnd?: number;
}

/**
 * How the band ends at a corridor's terminal end (course-layer.md §10.2
 * "Ends", F22): `"flat"` stops it on the line through the site's centre
 * across the leg, its outer corners rounded by `whiteMm`, and halves the
 * mouth's grown symbol; `"round"` wraps the site as before F22 (a round
 * end at h + whiteMm and the whole grown symbol).
 */
export type TerminalEnd = "flat" | "round";

/** The band's end the layer draws (F22, user answer 1: option 3, "flat, corners rounded"). */
export const TERMINAL_END: TerminalEnd = "flat";

export interface CorridorOptions {
  /** The band's end at a terminal end; `TERMINAL_END` when absent. */
  terminalEnd?: TerminalEnd;
}

/** A ring's end: round (a half disc about the end point) or flat (straight across it). */
type Cap = "round" | "flat";

interface EdgedSegment {
  a: Pt;
  b: Pt;
  half: number;
  ref: string;
  /** The site at `a` / `b` when the segment starts / ends the leg there. */
  siteA?: string;
  siteB?: string;
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

/** Runs of consecutive corridor legs of equal width and band, per course; the edged segments and every leg's two ends. */
function runsOf(courses: readonly DerivedCourse[]): { runs: Run[]; edged: EdgedSegment[]; ends: LegEnd[] } {
  const runs: Run[] = [];
  const edged: Omit<EdgedSegment, "capA" | "capB">[] = [];
  const ends: LegEnd[] = [];
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
      if (run && run.half === half && run.white === white) {
        run.pts.push(...pts);
        run.legs.push(pts);
        run.to = leg.to;
      } else {
        run = { pts: [...pts], legs: [pts], half, white, from: leg.from, to: leg.to };
        runs.push(run);
      }
      const distinct = simplify(pts);
      if (distinct.length >= 2) {
        ends.push({ siteId: leg.from, c: distinct[0], path: distinct, half, white, edge: k.edge });
        ends.push({ siteId: leg.to, c: distinct[distinct.length - 1], path: [...distinct].reverse(), half, white, edge: k.edge });
      }
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1], b = pts[j];
        if (!k.edge) {
          unedged.add(key(a));
          unedged.add(key(b));
          continue;
        }
        const g = half + EDGE_TOLERANCE_UM;
        edged.push({
          a, b, half, ref: `${c.id}:${i}`, ...(j === 1 ? { siteA: leg.from } : {}), ...(j === pts.length - 1 ? { siteB: leg.to } : {}),
          minX: Math.min(a.x, b.x) - g, minY: Math.min(a.y, b.y) - g, maxX: Math.max(a.x, b.x) + g, maxY: Math.max(a.y, b.y) + g,
        });
      }
    });
  }
  for (const r of runs) r.pts = simplify(r.pts);
  return { runs, ends, edged: edged.map((e) => ({ ...e, capA: !unedged.has(key(e.a)), capB: !unedged.has(key(e.b)) })) };
}

/**
 * The mouths (§10.2, F19): each control, finish or start a corridor leg
 * ends at, with its symbol's extent. A symbol that some leg's round end
 * there encloses (h ≥ the extent) adds nothing to the inside: the circle
 * sits inside the corridor as before F19 (user answer 1).
 */
function mouthsOf(ends: readonly LegEnd[], m: CorridorMouths): Map<string, Mouth> {
  const byId = new Map(m.sites.map((s) => [s.id, s] as const));
  const out = new Map<string, Mouth>();
  for (const e of ends) {
    if (out.has(e.siteId)) continue;
    const site = byId.get(e.siteId);
    if (!site || (site.role !== "control" && site.role !== "start" && site.role !== "finish")) continue;
    const extent = site.role === "control" ? m.circleUm : site.role === "finish" ? m.finishUm : m.startUm;
    if (!(extent > 0)) continue;
    const half = Math.max(...ends.filter((x) => x.siteId === e.siteId).map((x) => x.half));
    const mouth: Mouth = { site, c: e.c, extent, inInside: half < extent };
    if (site.role === "start") {
      // The glyph's apex is +y; the site turns it by angleDeg counter-clockwise (§3.3).
      const a0 = ((90 + (site.angleDeg ?? 0)) * Math.PI) / 180;
      mouth.corners = [0, 1, 2].map((k) => ({ x: e.c.x + extent * Math.cos(a0 + (2 * Math.PI * k) / 3), y: e.c.y + extent * Math.sin(a0 + (2 * Math.PI * k) / 3) }));
    }
    out.set(e.siteId, mouth);
  }
  return out;
}

/** A mouth's symbol grown by `w` (0: the symbol itself) as one ring: a disc, or the triangle with round corners. */
function mouthRing(mouth: Mouth, w: number): Polygon {
  const ring: [number, number][] = [];
  if (!mouth.corners) {
    const r = mouth.extent + w;
    ring.push([mouth.c.x + r, mouth.c.y]);
    arc(ring, mouth.c, r, 0, 2 * Math.PI);
    return [integral(ring)];
  }
  const k = mouth.corners;
  if (w <= 0) return [integral([...k.map((p): [number, number] => [p.x, p.y]), [k[0].x, k[0].y]])];
  for (let i = 0; i < 3; i++) {
    const prev = k[(i + 2) % 3], v = k[i], next = k[(i + 1) % 3];
    // Outward normals of the sides into and out of v (counter-clockwise ring: the right of travel).
    const nIn = Math.atan2(v.y - prev.y, v.x - prev.x) - Math.PI / 2;
    const nOut = Math.atan2(next.y - v.y, next.x - v.x) - Math.PI / 2;
    let sweep = nOut - nIn;
    while (sweep < 0) sweep += 2 * Math.PI;
    ring.push([v.x + w * Math.cos(nIn), v.y + w * Math.sin(nIn)]);
    arc(ring, v, w, nIn, sweep);
  }
  return [integral(ring)];
}

/**
 * A disc mouth's symbol grown by `w`, its near half only (F22, a terminal
 * end): the disc of radius R + w cut on the line through its centre across
 * `u` (the leg's bearing into the site), the side the leg comes from kept.
 * Its face on the line spans the circle's diameter (±R), and each corner is
 * the arc tangent to the line there and, inside, to the grown disc: radius
 * w(2R + w) / (2(R + w)), between w / 2 and w. So the whole near half of
 * the symbol stays in the white up to the line, for any w.
 */
function halfMouthRing(mouth: Mouth, w: number, u: Pt): Polygon {
  const c = mouth.c, R = mouth.extent, b = R + w, r = (w * (2 * R + w)) / (2 * b);
  const t = Math.atan2(u.y, u.x), ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
  // The corners' centres: r behind the line at ±q (q = R by the choice of r), R + w − r from the site (tangent to the
  // disc inside); φ their bearing from the site.
  const q = Math.sqrt(Math.max(0, (b - r) * (b - r) - r * r)), phi = Math.atan2(q, -r);
  const ring: [number, number][] = [[c.x - nx * q, c.y - ny * q], [c.x + nx * q, c.y + ny * q]];
  arc(ring, { x: c.x - ux * r + nx * q, y: c.y - uy * r + ny * q }, r, t, phi);
  arc(ring, c, b, t + phi, 2 * Math.PI - 2 * phi);
  arc(ring, { x: c.x - ux * r - nx * q, y: c.y - uy * r - ny * q }, r, t - phi, phi);
  return [integral(ring)];
}

/** Whether `p` lies in the convex counter-clockwise polygon `k` (its outline included). */
function inConvex(p: Pt, k: readonly Pt[]): boolean {
  for (let i = 0; i < k.length; i++) {
    const a = k[i], b = k[(i + 1) % k.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -1e-6) return false;
  }
  return true;
}

/**
 * The flat end of a run at a joined 701 (F19): the site moved back,
 * away from `toward`, until both sides at `h` reach the triangle — so the
 * straight sides end on it, not short of it with a notch. The site itself
 * when the sides already start inside it or never meet it.
 */
function backTo(mouth: Mouth, toward: Pt, h: number): Pt {
  const k = mouth.corners!, c = mouth.c;
  const len = Math.hypot(toward.x - c.x, toward.y - c.y);
  if (!len) return c;
  const ux = (toward.x - c.x) / len, uy = (toward.y - c.y) / len;
  let back = 0;
  for (const side of [1, -1]) {
    const o = { x: c.x - uy * h * side, y: c.y + ux * h * side };
    if (inConvex(o, k)) continue;
    // The side's line backwards, o − u·t: where it enters the triangle (the nearest crossing of a side, t ≥ 0).
    let enter = Infinity;
    for (let i = 0; i < 3; i++) {
      const a = k[i], b = k[(i + 1) % 3];
      // o − u·t = a + e·v, by Cramer's rule.
      const ex = b.x - a.x, ey = b.y - a.y, wx = a.x - o.x, wy = a.y - o.y;
      const den = ux * ey - ex * uy;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ex * wy - wx * ey) / den;
      const v = (uy * wx - ux * wy) / den;
      if (t >= 0 && v >= 0 && v <= 1) enter = Math.min(enter, t);
    }
    if (Number.isFinite(enter)) back = Math.max(back, enter);
  }
  return back > 0 ? round({ x: (c.x - ux * back) / 1000, y: (c.y - uy * back) / 1000 }) : c;
}

/** Distance from `p` to the segment a → b, µm. */
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Distance from `p` to a mouth's outline (the circle, or the triangle's sides), µm. */
function toOutline(p: Pt, mouth: Mouth): number {
  const k = mouth.corners;
  if (!k) return Math.abs(Math.hypot(p.x - mouth.c.x, p.y - mouth.c.y) - mouth.extent);
  return Math.min(distToSegment(p, k[0], k[1]), distToSegment(p, k[1], k[2]), distToSegment(p, k[2], k[0]));
}

/** Distance from `p` to the nearest edge of `rings`, µm, or Infinity beyond `limit` (bounds first). */
function toRings(p: Pt, rings: readonly FlatRing[], limit: number): number {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[2 * i], ay = r[2 * i + 1], bx = r[(2 * i + 2) % r.length], by = r[(2 * i + 3) % r.length];
      if (p.x < Math.min(ax, bx) - limit || p.x > Math.max(ax, bx) + limit || p.y < Math.min(ay, by) - limit || p.y > Math.max(ay, by) + limit) continue;
      best = Math.min(best, distToSegment(p, { x: ax, y: ay }, { x: bx, y: by }));
    }
  }
  return best;
}

/** Samples round a circle when finding the arcs inside a leg's corridor (0.5°); each arc's ends are then bisected. */
const OPENING_SAMPLES = 720;

/**
 * The openings (§10.2, F19): an edged leg with half width h < R at a
 * control opens the circle where it lies inside that leg's own corridor —
 * the arcs of the circle within h of the leg's polyline, each between two
 * junctions where the leg's sides cross the circle; on a straight end
 * segment exactly θ ± asin(h / R), θ the segment's bearing. An arc opens
 * when one of its junctions lies on the inside's boundary; a wider
 * corridor at the site covers both and leaves the circle whole.
 */
function openingsOf(ends: readonly LegEnd[], mouths: ReadonlyMap<string, Mouth>, inside: readonly FlatRing[]): Map<string, AngularGap[]> {
  const out = new Map<string, AngularGap[]>();
  for (const e of ends) {
    const mouth = mouths.get(e.siteId);
    if (!e.edge || !mouth || mouth.site.role !== "control" || !mouth.inInside) continue;
    const R = mouth.extent, h = e.half, c = e.c;
    if (!(h > 0 && h < R)) continue;
    // The leg's segments that come within h of the circle.
    // Each with its bounds grown by h and 1 µm for rounding: a point outside them is farther than h (F20b).
    const near: { p: Pt; q: Pt; x0: number; x1: number; y0: number; y1: number }[] = [];
    for (let i = 0; i + 1 < e.path.length; i++) {
      const p = e.path[i], q = e.path[i + 1], g = h + 1;
      if (distToSegment(c, p, q) <= R + h) near.push({ p, q, x0: Math.min(p.x, q.x) - g, x1: Math.max(p.x, q.x) + g, y0: Math.min(p.y, q.y) - g, y1: Math.max(p.y, q.y) + g });
    }
    const at = (a: number): Pt => ({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
    const inStrip = (a: number) => {
      const pt = at(a);
      return near.some((s) => pt.x >= s.x0 && pt.x <= s.x1 && pt.y >= s.y0 && pt.y <= s.y1 && distToSegment(pt, s.p, s.q) < h);
    };
    const step = (2 * Math.PI) / OPENING_SAMPLES;
    const flags = Array.from({ length: OPENING_SAMPLES }, (_, k) => inStrip(k * step));
    const first = flags.indexOf(false);
    if (first < 0) continue;
    /** The angle between `a` (whose state is `from`) and `b` where the state changes, to 1e-7 rad. */
    const bisect = (a: number, b: number, from: boolean) => {
      for (let i = 0; i < 24; i++) {
        const m = (a + b) / 2;
        if (inStrip(m) === from) a = m;
        else b = m;
      }
      return (a + b) / 2;
    };
    for (let k = 1; k <= OPENING_SAMPLES; k++) {
      const i = (first + k) % OPENING_SAMPLES;
      if (!flags[i] || flags[(i + OPENING_SAMPLES - 1) % OPENING_SAMPLES]) continue;
      // An arc inside the strip starts at sample i: find where it ends.
      let j = i;
      while (flags[(j + 1) % OPENING_SAMPLES]) j++;
      const a0 = bisect((first + k - 1) * step, (first + k) * step, false);
      const a1 = bisect((first + k + (j - i)) * step, (first + k + (j - i) + 1) * step, true);
      if (![a0, a1].some((a) => toRings(at(a), inside, JUNCTION_TOLERANCE_UM) <= JUNCTION_TOLERANCE_UM)) continue;
      // Math angles (counter-clockwise from +x) a0 → a1 are compass 90 − a1 → 90 − a0.
      const list = out.get(e.siteId) ?? [];
      const start = 90 - (a1 * 180) / Math.PI, sweep = ((a1 - a0) * 180) / Math.PI;
      const s0 = ((start % 360) + 360) % 360;
      list.push({ start: s0, end: s0 + sweep });
      out.set(e.siteId, list);
    }
  }
  return out;
}

/** Angular step of an arc of radius `h` flattened at the tolerance. */
const arcStep = (h: number) => 2 * Math.acos(Math.max(-1, 1 - TOLERANCE_UM / h));

/** Appends the arc about `c` of radius `h` from angle `a0` turning by `sweep` (signed), its end included, its start not. */
function arc(out: [number, number][], c: Pt, h: number, a0: number, sweep: number): void {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep(h)));
  for (let k = 1; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push([c.x + h * Math.cos(a), c.y + h * Math.sin(a)]);
  }
}

/**
 * One run's buffer at `h` as one ring (course-layer.md §10.2, F13): the
 * left offset forward, a round cap, the right offset back, a round cap.
 * At a vertex the outer side follows an arc about it and the inner side
 * runs through the vertex itself, so the ring's nonzero winding is the
 * round-joined buffer even where it crosses itself; the union cleans it.
 * A flat end (F19, at a joined 701) runs straight from one side to the
 * other through the site: the triangle, not a round end, closes it; so
 * does the band's at a terminal end (F22), before `cornerWedges` round
 * its corners.
 */
function runRing(pts: readonly Pt[], h: number, capStart: Cap = "round", capEnd: Cap = "round"): Polygon {
  const ring: [number, number][] = [];
  if (pts.length < 2) {
    const c = pts[0];
    ring.push([c.x + h, c.y]);
    arc(ring, c, h, 0, 2 * Math.PI);
    return [integral(ring)];
  }
  const dir = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
  /** One side, walking `p` in order: offset to the left of the direction of travel. */
  const side = (p: readonly Pt[]) => {
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i], b = p[i + 1], t = dir(a, b), nx = -Math.sin(t) * h, ny = Math.cos(t) * h;
      if (i === 0) ring.push([a.x + nx, a.y + ny]);
      ring.push([b.x + nx, b.y + ny]);
      if (i + 2 >= p.length) break;
      // The turn at b to the next segment: left (positive) puts this side inside, right outside.
      let turn = dir(b, p[i + 2]) - t;
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn <= -Math.PI) turn += 2 * Math.PI;
      if (turn > 0) ring.push([b.x, b.y]);
      else arc(ring, b, h, t + Math.PI / 2, turn);
      if (turn >= 0) {
        const u = t + turn;
        ring.push([b.x - Math.sin(u) * h, b.y + Math.cos(u) * h]);
      }
    }
  };
  const capAt = (end: Pt, before: Pt, cap: Cap) => {
    if (cap === "round") arc(ring, end, h, dir(before, end) + Math.PI / 2, -Math.PI);
  };
  side(pts);
  capAt(pts[pts.length - 1], pts[pts.length - 2], capEnd);
  const back = [...pts].reverse();
  side(back);
  capAt(back[back.length - 1], back[back.length - 2], capStart);
  return [integral(ring)];
}

/** How far back from a terminal end its bearing is taken, µm (F22): a flattened curve's last segments are µm long. */
const END_BEARING_UM = 1000;

/**
 * The point an end's bearing is taken from (F22): walking from the end of
 * `pts` (its last point when `atEnd`, else its first) back along it, the
 * first point at least `END_BEARING_UM` from the end, or the far end. On a
 * straight end segment of 1 mm or more, its other end; on a flattened
 * curve, the chord of its last millimetre, not a rounded µm segment.
 */
function bearingFrom(pts: readonly Pt[], atEnd: boolean): Pt {
  const n = pts.length, end = atEnd ? pts[n - 1] : pts[0];
  for (let k = 1; k < n; k++) {
    const p = atEnd ? pts[n - 1 - k] : pts[k];
    if (Math.hypot(p.x - end.x, p.y - end.y) >= END_BEARING_UM) return p;
  }
  return atEnd ? pts[0] : pts[n - 1];
}

/**
 * The run's part that keeps its band inside a terminal end's cut (F22,
 * spec review): every leg of the run but the terminal one — the end's own
 * leg is the only one cut — and of those only the stretches whose
 * segments come within reach of the cut: less than h + r behind the end
 * line (on the end's bearing) somewhere, and within √((h + w)² + w²) + h
 * of the end (w the cut's `reach`, `cornerWedges`). Each is a polyline whose buffer may enter the cut; a
 * stretch's own end is the run's site where the end's leg starts (its
 * round end there is that leg's join, kept) or a point too far behind or
 * away to reach it. None in the usual case: a run whose earlier legs stay
 * behind its end's reach, or a lone leg.
 */
function bodyNear(run: Run, atEnd: boolean, h: number, r: number, reach: number): Pt[][] {
  const pts = run.pts, n = pts.length, end = atEnd ? pts[n - 1] : pts[0], from = bearingFrom(pts, atEnd);
  const len = Math.hypot(end.x - from.x, end.y - from.y);
  if (run.legs.length < 2 || !len) return [];
  const ux = (end.x - from.x) / len, uy = (end.y - from.y) / len;
  const s = (p: Pt) => (p.x - end.x) * ux + (p.y - end.y) * uy;
  const body = simplify((atEnd ? run.legs.slice(0, -1) : run.legs.slice(1)).flat());
  const limit = Math.hypot(h + reach, reach) + h + 1;
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let k = 0; k + 1 < body.length; k++) {
    const a = body[k], b = body[k + 1];
    // Its buffer reaches the cut only from a point less than h + r behind the line (s is linear along it), and near.
    if (Math.max(s(a), s(b)) <= -(h + r) || distToSegment(end, a, b) > limit) {
      cur = null;
      continue;
    }
    if (!cur) out.push((cur = [a]));
    cur.push(b);
  }
  return out;
}

/**
 * What a flat end at `end` loses (F22): its round end — everything of the
 * ring at `h` past the end line within h + `reach` (the band's whiteMm) —
 * and its two corners, rounded by `r` (≤ reach): for each side, the
 * square corner between the line and r before it, from h − r out to
 * h + reach, less the quarter disc of radius r tangent to the line and the
 * side. The reach past h takes in a curved
 * run's own bulge near its end (its earlier sides stand out past h on the
 * outside of the curve, and across the line); the corners start r past
 * the line, so no edge of theirs lies on the ring's own end line (a 1 µm
 * sliver). Subtracted from the run's flat-ended ring, they leave its end
 * flat on the line with its corners rounded, however short the end
 * segment or curved the run; nothing changes farther than
 * √((h + reach)² + reach²) from the end.
 */
function cornerWedges(end: Pt, before: Pt, h: number, r: number, reach: number): Polygon[] {
  // `before`: the point the end's bearing is taken from (`bearingFrom`).
  const t = Math.atan2(end.y - before.y, end.x - before.x), ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
  const at = (s: number, n: number): [number, number] => [end.x + ux * s + nx * n, end.y + uy * s + ny * n];
  const g = h + reach;
  const beyond: [number, number][] = [at(0, -g)];
  arc(beyond, end, g, t - Math.PI / 2, Math.PI);
  return [[integral(beyond)], ...[1, -1].map((side): Polygon => {
    const ring: [number, number][] = [at(0, side * (h - r)), at(r, side * (h - r)), at(r, side * g), at(-r, side * g), at(-r, side * h)];
    // The quarter circle about (−r, ±(h − r)) from the side back to the line.
    const f = at(-r, side * (h - r));
    arc(ring, { x: f[0], y: f[1] }, r, t + (side * Math.PI) / 2, (-side * Math.PI) / 2);
    return [integral(ring)];
  })];
}

/** Integer µm, consecutive repeats dropped, closed: polygon-clipping's sweep is stable on it (float arcs crash it). */
function integral(ring: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, y] of ring) {
    const p: [number, number] = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
  return out;
}

/**
 * The round-joined buffer of every run at its half width plus `extra(run)`, and the `more` polygons, as one union;
 * `outer`: the band's buffer, whose terminal ends are cornered (F22).
 */
function buffer(runs: readonly Run[], extra: (r: Run) => number, more: readonly Polygon[] = [], outer = false): MultiPolygon {
  const rings: Polygon[] = [];
  for (const r of runs) {
    const h = r.half + extra(r);
    if (!(h > 0)) continue;
    const cs = outer ? r.cornerStart : undefined, ce = outer ? r.cornerEnd : undefined;
    const ring = runRing(r.pts, h, r.flatStart || cs !== undefined ? "flat" : "round", r.flatEnd || ce !== undefined ? "flat" : "round");
    if (cs === undefined && ce === undefined) {
      rings.push(ring);
      continue;
    }
    // F22: a terminal end, flat on the site; its corners rounded by whiteMm.
    const n = r.pts.length;
    const reach = extra(r);
    const wS = cs !== undefined ? cornerWedges(r.pts[0], bearingFrom(r.pts, false), h, Math.min(cs, h), reach) : [];
    const wE = ce !== undefined ? cornerWedges(r.pts[n - 1], bearingFrom(r.pts, true), h, Math.min(ce, h), reach) : [];
    // The cut is the end's: where the run's own earlier part passes through it (a hairpin, a figure eight), its
    // buffer is taken out of the cut, so that part keeps its band (review of F22; answer 4, never thinner). The
    // usual run never comes back near its end and is cut by the wedges themselves. Rounded to integer µm before
    // the difference (a float subtrahend can crash the sweep); a lone ring per stretch shares the run ring's offsets.
    const keep = (wedges: Polygon[], atEnd: boolean, corner: number | undefined): Polygon[] => {
      const body = corner === undefined ? [] : bodyNear(r, atEnd, h, Math.min(corner, h), reach).map((p) => runRing(p, h));
      return body.length ? wedges.flatMap((w) => integralMp(pc.difference(w, ...body))) : wedges;
    };
    rings.push(...pc.difference(ring, ...keep(wS, false, cs), ...keep(wE, true, ce)));
  }
  rings.push(...more);
  return rings.length ? pc.union(rings[0], ...rings.slice(1)) : [];
}

/** polygon-clipping output rounded to integer µm (`integral`), rings that collapse dropped. */
function integralMp(mp: MultiPolygon): Polygon[] {
  const out: Polygon[] = [];
  for (const poly of mp) {
    const [outer, ...holes] = poly.map((ring) => integral(ring));
    // A polygon whose outer ring collapses (fewer than three distinct points) goes with its holes.
    if (outer && outer.length >= 4) out.push([outer, ...holes.filter((ring) => ring.length >= 4)]);
  }
  return out;
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

/** Grid cell of the edged segments' index, µm. */
const EDGE_CELL_UM = 4000;

/** A grid cell's key: exact in a double for any cell of a sheet (|cx|, |cy| < 2²⁵, i.e. 134 km of paper). */
const cellKey = (cx: number, cy: number) => cx * 67108864 + cy;

/**
 * The edged segments bucketed by grid cell over their grown bounds, each
 * cell's indices ascending: a flattened curve (F13) has hundreds of
 * segments, and every boundary sample asks.
 */
function edgeIndex(edged: readonly EdgedSegment[]): Map<number, number[]> {
  const cells = new Map<number, number[]>();
  edged.forEach((s, i) => {
    for (let cx = Math.floor(s.minX / EDGE_CELL_UM); cx <= Math.floor(s.maxX / EDGE_CELL_UM); cx++) {
      for (let cy = Math.floor(s.minY / EDGE_CELL_UM); cy <= Math.floor(s.maxY / EDGE_CELL_UM); cy++) {
        const k = cellKey(cx, cy);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  });
  return cells;
}

const NO_SEGMENTS: number[] = [];

/**
 * The edged leg whose side (x, y) lies on, as the index of its ref in
 * `refIds` order (the first such segment of `candidates`, ascending); −1
 * when none.
 */
function edgedRefAt(x: number, y: number, edged: readonly EdgedSegment[], refIds: Int32Array, candidates: readonly number[]): number {
  const p = { x, y };
  for (const i of candidates) {
    const s = edged[i];
    if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue;
    if (Math.abs(distToEdged(p, s) - s.half) < EDGE_TOLERANCE_UM) return refIds[i];
  }
  return -1;
}

/**
 * The edged segments whose grown bounds meet the ring edge a → b's
 * bounds, ascending: a superset of those whose bounds hold any sample on
 * the edge (bounds grown by 1 µm), in ascending order, so the first match of
 * `edgedRefAt` is the cell lookup's (F20b: looked up once per ring edge,
 * not per 50 µm sample).
 */
function candidatesOf(ax: number, ay: number, bx: number, by: number, edged: readonly EdgedSegment[], index: Map<number, number[]>): number[] {
  // Grown by 1 µm: a sample's float midpoint never falls outside them by a rounding step.
  const x0 = Math.min(ax, bx) - 1, x1 = Math.max(ax, bx) + 1, y0 = Math.min(ay, by) - 1, y1 = Math.max(ay, by) + 1;
  const c0 = Math.floor(x0 / EDGE_CELL_UM), c1 = Math.floor(x1 / EDGE_CELL_UM), r0 = Math.floor(y0 / EDGE_CELL_UM), r1 = Math.floor(y1 / EDGE_CELL_UM);
  const meets = (i: number) => {
    const s = edged[i];
    return !(x1 < s.minX || x0 > s.maxX || y1 < s.minY || y0 > s.maxY);
  };
  if (c0 === c1 && r0 === r1) return (index.get(cellKey(c0, r0)) ?? NO_SEGMENTS).filter(meets);
  const set = new Set<number>();
  for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) for (const i of index.get(cellKey(cx, cy)) ?? NO_SEGMENTS) if (meets(i)) set.add(i);
  return [...set].sort((p, q) => p - q);
}

/**
 * The parts of the inside's boundary rings that run along edged legs. A
 * ring edge on a mouth's outline (both ends on the same symbol, F19) is
 * the symbol's, never the edge's: the edge ends where a side meets it.
 */
function edgesOf(inside: FlatRing[], edged: readonly EdgedSegment[], mouths: readonly Mouth[] = []): CorridorEdge[] {
  if (!edged.length) return [];
  const index = edgeIndex(edged);
  // Refs by number, so a sample holds an integer (F20b: the samples are flat arrays, not objects).
  const refs: string[] = [];
  const refId = new Map<string, number>();
  const refIds = Int32Array.from(edged, (s) => {
    let id = refId.get(s.ref);
    if (id === undefined) {
      id = refs.push(s.ref) - 1;
      refId.set(s.ref, id);
    }
    return id;
  });
  const onMouth = (a: Pt, b: Pt) => mouths.some((m) => toOutline(a, m) <= MOUTH_TOLERANCE_UM && toOutline(b, m) <= MOUTH_TOLERANCE_UM);
  const out: CorridorEdge[] = [];
  for (const ring of inside) {
    const n = ring.length / 2;
    // Samples around the ring: each a point, the ref of the piece from it to the next sample, whether it is a vertex.
    let total = 0;
    for (let i = 0; i < n; i++) {
      const ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[(2 * i + 2) % ring.length], by = ring[(2 * i + 3) % ring.length];
      total += Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / EDGE_STEP_UM));
    }
    const sx = new Float64Array(total), sy = new Float64Array(total), sref = new Int32Array(total), svertex = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < n; i++) {
      const a = { x: ring[2 * i], y: ring[2 * i + 1] };
      const b = { x: ring[(2 * i + 2) % ring.length], y: ring[(2 * i + 3) % ring.length] };
      const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / EDGE_STEP_UM));
      const symbol = mouths.length > 0 && onMouth(a, b);
      const candidates = symbol ? NO_SEGMENTS : candidatesOf(a.x, a.y, b.x, b.y, edged, index);
      for (let j = 0; j < k; j++, at++) {
        const t0 = j / k, tm = (j + 0.5) / k;
        sx[at] = j === 0 ? a.x : Math.round(a.x + (b.x - a.x) * t0);
        sy[at] = j === 0 ? a.y : Math.round(a.y + (b.y - a.y) * t0);
        sref[at] = symbol ? -1 : edgedRefAt(a.x + (b.x - a.x) * tm, a.y + (b.y - a.y) * tm, edged, refIds, candidates);
        svertex[at] = j === 0 ? 1 : 0;
      }
    }
    if (sref.every((r) => r >= 0 && r === sref[0])) {
      out.push({ points: ringPoints(ring), closed: true, ref: refs[sref[0]] });
      continue;
    }
    // Start at a change so no piece wraps around the ring's first point; none = no edged part on this ring.
    let start = -1;
    for (let i = 0; i < total; i++) {
      if (sref[i] !== sref[(i + total - 1) % total]) {
        start = i;
        break;
      }
    }
    if (start < 0) continue;
    let cur: CorridorEdge | null = null, curRef = -1;
    for (let k = 0; k <= total; k++) {
      const s = (start + k) % total;
      if (cur && (k === total || sref[s] !== curRef)) {
        cur.points.push({ x: sx[s], y: sy[s] });
        if (cur.points.length >= 2) out.push(cur);
        cur = null;
      }
      if (k === total) break;
      if (!cur && sref[s] >= 0) {
        cur = { points: [{ x: sx[s], y: sy[s] }], closed: false, ref: refs[sref[s]] };
        curRef = sref[s];
      } else if (cur && svertex[s]) cur.points.push({ x: sx[s], y: sy[s] });
    }
  }
  return out;
}

const ringPoints = (r: FlatRing): Pt[] => Array.from({ length: r.length / 2 }, (_, i) => ({ x: r[2 * i], y: r[2 * i + 1] }));

/** A number as the key spells it: `-0` apart from `0`, since the rings keep the sign of a zero. */
const num = (v: number | undefined) => (v === undefined ? "u" : v === 0 && 1 / v < 0 ? "-0" : String(v));

/**
 * Everything `computeCorridorGeometry` reads, as one string: per course
 * its id and per leg its index, and for a corridor leg its ends, width,
 * band, edge and points; the extents and the sites a corridor leg ends
 * at (id, role, position, turn), in the order given; the terminal end
 * (F22).
 */
function inputKey(courses: readonly DerivedCourse[], mouths: CorridorMouths | undefined, terminalEnd: TerminalEnd): string {
  const parts: string[] = [`T${terminalEnd}`];
  const ends = new Set<string>();
  for (const c of courses) {
    parts.push(`C${c.id.length}:${c.id}`);
    for (const leg of c.legs) {
      const k = leg.corridor;
      if (!k) {
        parts.push("-");
        continue;
      }
      ends.add(leg.from);
      ends.add(leg.to);
      const pts: string[] = [];
      for (const p of leg.points) pts.push(num(p.x), num(p.y));
      parts.push(`L${leg.from.length}:${leg.from}${leg.to.length}:${leg.to}|${num(k.widthMm)}|${num(k.whiteMm)}|${k.edge ? 1 : 0}|${pts.join(",")}`);
    }
  }
  if (mouths) {
    parts.push(`M${num(mouths.circleUm)}|${num(mouths.finishUm)}|${num(mouths.startUm)}`);
    for (const site of mouths.sites) {
      if (ends.has(site.id)) parts.push(`S${site.id.length}:${site.id}|${site.role}|${num(site.x)}|${num(site.y)}|${num(site.angleDeg)}`);
    }
  }
  return parts.join("\n");
}

/** The last call's input key and result (F20b): a request that leaves the corridors as they were reuses them. */
let last: { key: string; geometry: CorridorGeometry | null } | null = null;

/**
 * The corridors of the derived courses: the union of their insides, the
 * band outside them, the edged legs' outlines and, with `mouths` (the
 * drawn sites and the symbols' extents, F19), the symbols the legs end at
 * joined in and the circles' openings. `null` when no leg has a corridor.
 *
 * The result of the last call is kept and returned again — the same
 * object — while everything the geometry reads is unchanged (F20b,
 * course-layer.md §10.2): a number, a course object or a control of
 * another course dragged over a corridor course leaves the corridors as
 * they were, and their unions are most of a request's cost. Callers
 * treat the result as read-only.
 */
export function corridorGeometry(courses: readonly DerivedCourse[], mouths?: CorridorMouths, options?: CorridorOptions): CorridorGeometry | null {
  const terminalEnd = options?.terminalEnd ?? TERMINAL_END;
  const key = inputKey(courses, mouths, terminalEnd);
  if (last?.key === key) return last.geometry;
  const geometry = computeCorridorGeometry(courses, mouths, terminalEnd);
  last = { key, geometry };
  return geometry;
}

/**
 * The sites with exactly one corridor-leg end over every course (F22,
 * user answer 4): there the band stops. A control inside a run, a change
 * of width or band, two courses' corridors meeting, a loop or a reversal
 * each have two or more.
 */
function terminalSites(ends: readonly LegEnd[]): Set<string> {
  const count = new Map<string, number>();
  for (const e of ends) count.set(e.siteId, (count.get(e.siteId) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n === 1).map(([id]) => id));
}

function computeCorridorGeometry(courses: readonly DerivedCourse[], mouths: CorridorMouths | undefined, terminalEnd: TerminalEnd): CorridorGeometry | null {
  const { runs, edged: edgedRaw, ends } = runsOf(courses);
  if (!runs.length) return null;
  const sites = mouths ? mouthsOf(ends, mouths) : new Map<string, Mouth>();
  const joined = [...sites.values()].filter((m) => m.inInside);
  // At a mouth whose symbol joins the inside, a leg's round end is inside the symbol or, at a start, past it: not the edge's.
  const isMouth = (id: string | undefined) => id !== undefined && !!sites.get(id)?.inInside;
  const edged = edgedRaw.map((e) => ({ ...e, capA: e.capA && !isMouth(e.siteA), capB: e.capB && !isMouth(e.siteB) }));
  // A run that starts or ends at a joined 701 ends flat there, its sides carried back to the triangle (`backTo`):
  // its round end would bulge past the triangle's base. The edged segment there starts where the side meets it.
  const startOf = (id: string | undefined) => {
    const m = id === undefined ? undefined : sites.get(id);
    return m?.inInside && m.corners ? m : undefined;
  };
  for (const r of runs) {
    if (r.pts.length < 2) continue;
    const a = startOf(r.from), b = startOf(r.to);
    if (a) {
      r.pts = [backTo(a, r.pts[1], r.half), ...r.pts.slice(1)];
      r.flatStart = true;
    }
    if (b) {
      r.pts = [...r.pts.slice(0, -1), backTo(b, r.pts[r.pts.length - 2], r.half)];
      r.flatEnd = true;
    }
  }
  for (const e of edged) {
    const a = startOf(e.siteA), b = startOf(e.siteB);
    if (a) e.a = backTo(a, e.b, e.half);
    if (b) e.b = backTo(b, e.a, e.half);
    if (a || b) {
      const g = e.half + EDGE_TOLERANCE_UM;
      Object.assign(e, { minX: Math.min(e.a.x, e.b.x) - g, minY: Math.min(e.a.y, e.b.y) - g, maxX: Math.max(e.a.x, e.b.x) + g, maxY: Math.max(e.a.y, e.b.y) + g });
    }
  }
  const insideMp = buffer(runs, () => 0, joined.map((m) => mouthRing(m, 0)));
  const inside = flat(insideMp);
  let band: FlatRing[] | null = null;
  const banded = runs.filter((r) => r.white > 0);
  if (banded.length) {
    // F22: at a terminal end (not a start: answer 2) the band stops on the line through the site, its corners rounded by whiteMm.
    const terminal = terminalEnd === "flat" ? terminalSites(ends) : new Set<string>();
    for (const s of sites.values()) if (s.site.role === "start") terminal.delete(s.site.id);
    // The corner (user, 2026-11-09, "fix the bump"): where the band reaches past the end's circle (h + w > R) it is
    // the end's only shape — one corner of radius min(w, h + w − R), its face on the line spanning ±R at least, so the
    // circle's near half stays in the white up to the line; the mouth adds no half (below). Where it does not
    // (h + w ≤ R), the corner is w and the mouth's half wraps the circle.
    const cornerAt = (r: Run, id: string) => {
      const m = sites.get(id), R = m && !m.corners ? m.extent : 0, H = r.half + r.white;
      return H > R ? Math.min(r.white, H - R) : r.white;
    };
    for (const r of banded) {
      if (r.pts.length < 2) continue;
      if (terminal.has(r.from) && !r.flatStart) r.cornerStart = cornerAt(r, r.from);
      if (terminal.has(r.to) && !r.flatEnd) r.cornerEnd = cornerAt(r, r.to);
    }
    // A mouth's band: its symbol grown by the largest whiteMm of the legs ending there, unless a leg's band there encloses it.
    // At a terminal end its near half only, the side the leg comes from, and only where the band is no wider than the
    // circle (F22).
    const more: Polygon[] = [];
    for (const m of sites.values()) {
      const here = ends.filter((e) => e.siteId === m.site.id);
      const white = Math.max(...here.map((e) => e.white));
      if (!(white > 0) || here.some((e) => e.white > 0 && e.half + e.white >= m.extent + white)) continue;
      // The same bearing as the run's cut there: its path from the site on, read back from its far end.
      // Without a bearing (a degenerate path) the mouth stays whole.
      const e = here[0], from = bearingFrom(e.path, false), u = { x: e.c.x - from.x, y: e.c.y - from.y };
      // A terminal end whose band reaches past the circle has no half: the run's one corner wraps it (above).
      if (terminal.has(m.site.id) && !m.corners && e.half + e.white > m.extent) continue;
      more.push(terminal.has(m.site.id) && !m.corners && (u.x || u.y) ? halfMouthRing(m, white, u) : mouthRing(m, white));
    }
    const outer = buffer(banded, (r) => r.white, more, true);
    const rings = flat(pc.difference(outer, insideMp));
    if (rings.length) band = rings;
  }
  return { inside, band, edges: edgesOf(inside, edged, joined), openings: openingsOf(ends, sites, inside) };
}

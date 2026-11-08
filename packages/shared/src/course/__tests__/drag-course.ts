/**
 * The F20 drag fixture (docs/bugfix-course-drag-redraw.md): a synthetic
 * 25-control course at 1:15 000 with one F18-style smooth bend on every
 * leg — the shape that took a course from 52 leg points to 1100 and the
 * derivation from 69 ms to 400 ms — over 3000 point features for the
 * automatic cuts. Shared by the budget tests; the coordinates are seeded,
 * so every run derives the same course.
 */

import type { PlacementCircle, PlacementSeg } from "../../course-maps/control-label-placement.js";
import type { MapPoint, PathVertex } from "../../course-maps/schema.js";
import type { CorridorMouths } from "../corridor.js";
import type { CourseMetrics } from "../derive.js";
import type { CourseDerivation, CourseItem, CourseLayerInput, CourseSite, CourseStructure, CutFeature } from "../types.js";
import { isomContext } from "./helpers.js";

/** mulberry32: a small seeded generator, so the fixture is the same on every machine. */
export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISOM 2017-2 at 1:15 000 (the derive tests' sizes). */
export const DRAG_METRICS: CourseMetrics = { circleRadiusMm: 2.5, finishRadiusMm: 3, startRadiusMm: 6 / Math.sqrt(3), numberEmMm: 4 * (2048 / 1409), lineWidthMm: 0.35 };

const r2 = (v: number) => Math.round(v * 100) / 100;

/** F18's smooth handles on [a, …bends, b]: hOut = (next − prev) / 6, hIn = −hOut. */
function smoothBends(a: MapPoint, pts: MapPoint[], b: MapPoint): PathVertex[] {
  const path = [a, ...pts, b];
  return pts.map((p, i) => {
    const prev = path[i], next = path[i + 2];
    const hOut = { x: r2((next.x - prev.x) / 6), y: r2((next.y - prev.y) / 6) };
    return { x: p.x, y: p.y, hIn: { x: -hOut.x, y: -hOut.y }, hOut };
  });
}

export interface DragCourseOptions {
  controls?: number;
  /** Smooth bends per leg (0: straight legs, the pre-F13 shape). */
  bendsPerLeg?: number;
  /** Point features for the automatic cuts. */
  features?: number;
  /** A corridor on every leg (F20b: the corridor drag fixture; 50 m at 1:15 000 is narrower than the circle). */
  corridor?: { widthM: number; edge: boolean; whiteMm: number };
}

/** The course on a zig-zag ring round (150, 150), alternately 55 and 110 mm out, each bend 8 mm off the chord. */
export function dragCourse({ controls = 25, bendsPerLeg = 1, features = 3000, corridor }: DragCourseOptions = {}): CourseLayerInput {
  const r = seeded(42);
  const n = controls + 2;
  const sites: CourseSite[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const rad = (i % 2 ? 110 : 55) + (r() - 0.5) * 10;
    const kind = i === 0 ? "start" : i === n - 1 ? "finish" : "control";
    sites.push({ id: `s${i}`, code: i === 0 ? "S1" : i === n - 1 ? "F1" : String(30 + i), kind, x: r2(150 + rad * Math.cos(th)), y: r2(150 + rad * Math.sin(th)) });
  }
  const legCorridor = corridor ? { corridor: { ...corridor, whiteOpacity: 1 } } : {};
  const items: CourseItem[] = sites.map((s, i) => {
    if (i === 0) return { siteId: s.id };
    if (bendsPerLeg === 0) return corridor ? { siteId: s.id, leg: legCorridor } : { siteId: s.id };
    const a = sites[i - 1];
    const dx = s.x - a.x, dy = s.y - a.y, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len, sign = i % 2 ? 1 : -1;
    const pts: MapPoint[] = [];
    for (let k = 1; k <= bendsPerLeg; k++) {
      const t = k / (bendsPerLeg + 1);
      pts.push({ x: r2(a.x + dx * t + nx * 8 * sign), y: r2(a.y + dy * t + ny * 8 * sign) });
    }
    return { siteId: s.id, leg: { bends: smoothBends(a, pts, s), ...legCorridor } };
  });
  const structure: CourseStructure = { version: 1, id: "H21", orderMode: "ordered", items };
  const f = seeded(7);
  const cutFeatures: CutFeature[] = Array.from({ length: features }, () => ({ x: f() * 300, y: f() * 300, r: 0.25 }));
  return { structure, sites, objects: [], appearance: {}, viewOptions: { labelMode: "sequence" }, document: isomContext(), cutFeatures };
}

/** The placer's input as `deriveCourse` builds it from a derivation: every site an obstacle, controls labelled, legs as screen segments (y down). */
export function placementInput(d: CourseDerivation, m: CourseMetrics = DRAG_METRICS): { circles: PlacementCircle[]; lines: PlacementSeg[] } {
  const circles: PlacementCircle[] = d.sites.map((s) => ({ id: s.id, x: s.x, y: -s.y, radius: m.circleRadiusMm, ...(s.role === "control" ? { label: s.code } : {}) }));
  const lines: PlacementSeg[] = [];
  for (const c of d.courses) {
    for (const leg of c.legs) {
      for (const piece of leg.pieces) {
        for (let i = 1; i < piece.length; i++) lines.push({ x1: piece[i - 1].x, y1: -piece[i - 1].y, x2: piece[i].x, y2: -piece[i].y });
      }
    }
  }
  return { circles, lines };
}

/** The ISOM 1:15 000 symbol extents of `DRAG_METRICS`, µm, as `corridorGeometry`'s mouths take them (F19). */
export function dragMouths(d: CourseDerivation, m: CourseMetrics = DRAG_METRICS): CorridorMouths {
  return { sites: d.sites, circleUm: m.circleRadiusMm * 1000, finishUm: m.finishRadiusMm * 1000, startUm: m.startRadiusMm * 1000 };
}

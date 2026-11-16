/**
 * The GPS-track reference layer decimated to the pixel (docs/map-gps-tracks.md §5.1 "Decimation to the pixel"):
 * `simplifyTrack` (§3.4) at half a CSS pixel of the zoom the pointer last reported, rounded down to its octave so a
 * line is simplified again only when the zoom crosses a power of two, under one point budget for every visible track.
 * An average's single-pass spans (§4.1) are their own runs, drawn dashed (§5.2, G27).
 */

import { gpsTrack } from "@oxygen/shared";
import type { ToolShape } from "../../../../../components/MapViewer";

/** The tolerance before any zoom is known (mm). */
export const DEFAULT_TOLERANCE_MM = 0.01;
/** Drawn points of every visible track together. */
export const LAYER_POINT_BUDGET = 50_000;

/** `0.5 × 2^⌊log₂ mmPerPx⌋` mm: at most half a pixel, recomputed per octave. */
export function toleranceMm(mmPerPx: number | null): number {
  if (mmPerPx === null || !(mmPerPx > 0) || !Number.isFinite(mmPerPx)) return DEFAULT_TOLERANCE_MM;
  return 0.5 * 2 ** Math.floor(Math.log2(mmPerPx));
}

export interface LayerLine {
  id: string;
  colour: string;
  line: gpsTrack.ProjectedTrack;
  /** Single-pass ranges of `line`'s points (an average's, under its trim: `edit.ts` `viewRanges`), drawn dashed. */
  dashed?: readonly gpsTrack.TrackRange[];
}

/** A run of a line, inclusive point indices `start … end`. */
export interface LineRun { start: number; end: number; dashed: boolean }

export interface DecimatedLayer {
  /** The tolerance used: the asked one, doubled while the budget was exceeded. */
  tolerance: number;
  lines: { id: string; colour: string; points: { x: number; y: number }[]; runs?: { points: { x: number; y: number }[]; dashed: boolean }[] }[];
}

/**
 * The solid and dashed runs of an `n`-point line with single-pass ranges `[start, end)` (ascending, disjoint): a
 * dashed run spans its range's first to last sample; runs touch (a solid run ends where the dashed one starts); a run
 * under two points is left out, so a one-sample range has none and the solid runs meet there.
 */
export function runsOf(n: number, ranges: readonly gpsTrack.TrackRange[]): LineRun[] {
  const out: LineRun[] = [];
  let at = 0;
  for (const r of ranges) {
    const s = Math.max(r.start, at), e = Math.min(r.end, n) - 1;
    if (e < s) continue;
    if (s > at) out.push({ start: at, end: s, dashed: false });
    if (e > s) out.push({ start: s, end: e, dashed: true });
    at = Math.max(at, e);
  }
  if (n - 1 > at) out.push({ start: at, end: n - 1, dashed: false });
  return out;
}

/** Simplified lines per projected line and tolerance: a pan or an unrelated render does not simplify again. */
const cache = new WeakMap<gpsTrack.ProjectedTrack, Map<number, gpsTrack.ProjectedTrack>>();
/** A line's runs per ranges, their points as lines of their own (so each is simplified once per tolerance, its ends kept). */
const runCache = new WeakMap<gpsTrack.ProjectedTrack, Map<string, { line: gpsTrack.ProjectedTrack; dashed: boolean }[]>>();

function simplified(line: gpsTrack.ProjectedTrack, tol: number): gpsTrack.ProjectedTrack {
  let byTol = cache.get(line);
  if (!byTol) cache.set(line, (byTol = new Map()));
  let out = byTol.get(tol);
  if (!out) byTol.set(tol, (out = gpsTrack.simplifyTrack(line, tol)));
  return out;
}

function runLines(l: LayerLine): { line: gpsTrack.ProjectedTrack; dashed: boolean }[] | null {
  if (!l.dashed || l.dashed.length === 0) return null;
  const key = l.dashed.map((r) => `${r.start}-${r.end}`).join(",");
  let byKey = runCache.get(l.line);
  if (!byKey) runCache.set(l.line, (byKey = new Map()));
  let out = byKey.get(key);
  if (!out) {
    out = runsOf(l.line.x.length, l.dashed).map((r) => ({
      dashed: r.dashed,
      line: { x: l.line.x.subarray(r.start, r.end + 1), y: l.line.y.subarray(r.start, r.end + 1), metresPerMm: l.line.metresPerMm },
    }));
    byKey.set(key, out);
  }
  return out;
}

const pointsOf = (t: gpsTrack.ProjectedTrack) => Array.from(t.x, (x, k) => ({ x, y: t.y[k] }));

/** The visible lines at `tolerance`, doubled until their points fit `budget` (ends always kept). */
export function decimateLayer(lines: readonly LayerLine[], tolerance: number, budget: number = LAYER_POINT_BUDGET): DecimatedLayer {
  const runs = lines.map(runLines);
  const at = (tol: number) => lines.map((l, i) => runs[i]?.map((r) => ({ dashed: r.dashed, line: simplified(r.line, tol) })) ?? [{ dashed: false, line: simplified(l.line, tol) }]);
  const count = (d: ReturnType<typeof at>) => d.reduce((s, rs) => s + rs.reduce((t, r) => t + r.line.x.length, 0), 0);
  let tol = tolerance;
  let drawn = at(tol);
  // Two points a run is the floor; past it no tolerance helps.
  const floor = 2 * runs.reduce((s, r) => s + (r?.length ?? 1), 0);
  for (let i = 0; i < 64 && count(drawn) > Math.max(budget, floor); i++) {
    tol *= 2;
    drawn = at(tol);
  }
  return {
    tolerance: tol,
    lines: lines.map((l, i) => {
      if (!runs[i]) return { id: l.id, colour: l.colour, points: pointsOf(drawn[i][0].line) };
      const rs = drawn[i].map((r) => ({ points: pointsOf(r.line), dashed: r.dashed }));
      return { id: l.id, colour: l.colour, points: rs.flatMap((r) => r.points), runs: rs };
    }),
  };
}

/**
 * One UI-layer path per line (`editor-gps-track`, `data-track-id`): 2 CSS px, solid, in its colour; a line with
 * single-pass runs is one path per run, the dashed ones with `data-single-pass`.
 */
export function layerShapes(layer: DecimatedLayer): ToolShape[] {
  return layer.lines.flatMap((l): ToolShape[] => {
    if (!l.runs) return [{ kind: "line", points: l.points, color: l.colour, widthPx: 2, testId: "editor-gps-track", data: { "track-id": l.id } }];
    return l.runs.map((r) => (r.dashed
      ? { kind: "line", points: r.points, color: l.colour, widthPx: 2, dashed: true, testId: "editor-gps-track", data: { "track-id": l.id, "single-pass": "true" } }
      : { kind: "line", points: r.points, color: l.colour, widthPx: 2, testId: "editor-gps-track", data: { "track-id": l.id } }));
  });
}

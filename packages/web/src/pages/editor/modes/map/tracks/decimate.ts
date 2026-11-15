/**
 * The GPS-track reference layer decimated to the pixel (docs/map-gps-tracks.md §5.1 "Decimation to the pixel"):
 * `simplifyTrack` (§3.4) at half a CSS pixel of the zoom the pointer last reported, rounded down to its octave so a
 * line is simplified again only when the zoom crosses a power of two, under one point budget for every visible track.
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
}

export interface DecimatedLayer {
  /** The tolerance used: the asked one, doubled while the budget was exceeded. */
  tolerance: number;
  lines: { id: string; colour: string; points: { x: number; y: number }[] }[];
}

/** Simplified lines per projected line and tolerance: a pan or an unrelated render does not simplify again. */
const cache = new WeakMap<gpsTrack.ProjectedTrack, Map<number, gpsTrack.ProjectedTrack>>();

function simplified(line: gpsTrack.ProjectedTrack, tol: number): gpsTrack.ProjectedTrack {
  let byTol = cache.get(line);
  if (!byTol) cache.set(line, (byTol = new Map()));
  let out = byTol.get(tol);
  if (!out) byTol.set(tol, (out = gpsTrack.simplifyTrack(line, tol)));
  return out;
}

/** The visible lines at `tolerance`, doubled until their points fit `budget` (ends always kept). */
export function decimateLayer(lines: readonly LayerLine[], tolerance: number, budget: number = LAYER_POINT_BUDGET): DecimatedLayer {
  let tol = tolerance;
  let drawn = lines.map((l) => simplified(l.line, tol));
  // Two points a line is the floor; past it no tolerance helps.
  for (let i = 0; i < 64 && drawn.reduce((s, d) => s + d.x.length, 0) > Math.max(budget, 2 * lines.length); i++) {
    tol *= 2;
    drawn = lines.map((l) => simplified(l.line, tol));
  }
  return {
    tolerance: tol,
    lines: lines.map((l, i) => ({ id: l.id, colour: l.colour, points: Array.from(drawn[i].x, (x, k) => ({ x, y: drawn[i].y[k] })) })),
  };
}

/** One UI-layer path per line (`editor-gps-track`, `data-track-id`): 2 CSS px, solid, in its colour. */
export function layerShapes(layer: DecimatedLayer): ToolShape[] {
  return layer.lines.map((l) => ({ kind: "line", points: l.points, color: l.colour, widthPx: 2, testId: "editor-gps-track", data: { "track-id": l.id } }));
}

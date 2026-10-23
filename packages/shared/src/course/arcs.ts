/**
 * Circles and arcs as cubic Bézier paths (paper µm, y-up), so a control
 * circle with gaps is an ordinary line object (docs/course-layer.md §3).
 */

import { COORD_FLAG, type RenderPath, makePath } from "../render/pass-stream.js";
import { type AngularGap, circleArcs } from "../course-maps/overlay-geometry.js";

const RAD = Math.PI / 180;

/**
 * Arc from math angle `fromDeg` to `toDeg` (counter-clockwise from +x;
 * `toDeg < fromDeg` runs clockwise) in ≤ 90° cubic segments.
 */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, closed = false): RenderPath {
  const sweep = toDeg - fromDeg;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / 90 - 1e-9));
  const step = (sweep / n) * RAD;
  const k = (4 / 3) * Math.tan(step / 4);
  const coords: number[] = [];
  const flags: number[] = [];
  const at = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  let a0 = fromDeg * RAD;
  const [x0, y0] = at(a0);
  coords.push(x0, y0);
  flags.push(0);
  for (let i = 0; i < n; i++) {
    const a1 = a0 + step;
    const [sx, sy] = at(a0);
    const [ex, ey] = at(a1);
    coords.push(sx - k * r * Math.sin(a0), sy + k * r * Math.cos(a0));
    coords.push(ex + k * r * Math.sin(a1), ey - k * r * Math.cos(a1));
    coords.push(ex, ey);
    flags.push(COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0);
    a0 = a1;
  }
  return makePath(coords.map(Math.round), flags, closed);
}

/**
 * The visible arcs of a control circle with `gaps` (compass degrees). An
 * arc that runs through north is one path, not two; no gap → one closed
 * circle.
 */
export function circleWithGaps(cx: number, cy: number, r: number, gaps: AngularGap[]): RenderPath[] {
  const arcs = circleArcs(gaps);
  if (arcs.length === 1 && arcs[0][0] === 0 && arcs[0][1] === 360) return [arcPath(cx, cy, r, 90, -270, true)];
  if (arcs.length > 1 && arcs[0][0] === 0 && arcs[arcs.length - 1][1] === 360) {
    const first = arcs.shift()!;
    arcs[arcs.length - 1] = [arcs[arcs.length - 1][0], first[1] + 360];
  }
  // Compass c → math 90 − c; clockwise on the compass is clockwise in math too.
  return arcs.map(([s, e]) => arcPath(cx, cy, r, 90 - s, 90 - e));
}

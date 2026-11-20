/**
 * The `nodes` tool shape's dots (docs/map-gps-tracks.md §5.2 "Nodes", G30): a GPS track's stored points thinned in
 * screen space, drawn by `MapViewer.tsx` `toolShapeNode`. Apart from the viewer for fast refresh.
 */

import type { ToolShape } from "../../components/MapViewer";

/** The most dots one `nodes` shape draws (its spacing doubles until it fits). */
export const TRACK_NODES_MAX = 4000;

type Proj = (x: number, y: number) => { x: number; y: number } | null;
const nodesCache = new WeakMap<object, { key: string; project: Proj; pts: { x: number; y: number }[] }>();

/** A `nodes` shape's dots in screen px: its indices projected, or its range thinned to `gapPx` (cached per view). */
export function nodePoints(sh: Extract<ToolShape, { kind: "nodes" }>, project: Proj): { x: number; y: number }[] {
  if (sh.indices) return sh.indices.map((i) => project(sh.x[i], sh.y[i])).filter((q): q is { x: number; y: number } => q !== null);
  const from = sh.from ?? 0, to = sh.to ?? sh.x.length - 1;
  if (to < from) return [];
  const a = project(sh.x[from], sh.y[from]), b = project(sh.x[to], sh.y[to]);
  const key = `${from},${to},${sh.gapPx},${a?.x},${a?.y},${b?.x},${b?.y}`;
  const hit = nodesCache.get(sh.x);
  // The projection is a new function per view (rotation, zoom, pan, the 3D camera): it is part of the key.
  if (hit?.key === key && hit.project === project) return hit.pts;
  const proj: ({ x: number; y: number } | null)[] = [];
  for (let i = from; i <= to; i++) proj.push(project(sh.x[i], sh.y[i]));
  let gap = Math.max(0, sh.gapPx ?? 0), pts: { x: number; y: number }[];
  for (;;) {
    pts = [];
    let last: { x: number; y: number } | null = null;
    const g2 = gap * gap;
    for (const q of proj) {
      if (!q) continue;
      if (last && (q.x - last.x) ** 2 + (q.y - last.y) ** 2 < g2) continue;
      pts.push(q);
      last = q;
    }
    if (pts.length <= TRACK_NODES_MAX) break;
    gap = Math.max(1, gap * 2);
  }
  nodesCache.set(sh.x, { key, project, pts });
  return pts;
}


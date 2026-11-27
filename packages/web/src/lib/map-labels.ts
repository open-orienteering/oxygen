/**
 * Where the map's HTML labels sit (docs/course-elevation.md §7.8): the
 * alternatives' pills over the viewer, in container px.
 */

type At = { x: number; y: number };

/**
 * Labels that would overlap are moved apart vertically, the first keeping its place; one off screen is left out.
 * A label is also moved off every point of `avoid` (the tool's handles and grips: a label over one would take its press).
 */
export function placeMapLabels<T extends { at: At }>(labels: readonly T[], size: { w: number; h: number }, avoid: readonly At[] = [], w = 150, h = 22): T[] {
  const out: T[] = [];
  /** A handle's reach beside the label's box. */
  const pad = 12;
  for (const l of labels) {
    if (l.at.x < 0 || l.at.x > size.w || l.at.y < 0 || l.at.y > size.h) continue;
    let y = l.at.y;
    for (let guard = 0; guard < out.length + avoid.length + 1; guard++) {
      const hit = out.find((o) => Math.abs(o.at.x - l.at.x) < w && Math.abs(o.at.y - y) < h);
      if (hit) { y = hit.at.y + h; continue; }
      const point = avoid.find((a) => Math.abs(a.x - l.at.x) < w / 2 + pad && Math.abs(a.y - y) < h / 2 + pad);
      if (!point) break;
      y = point.y + h / 2 + pad;
    }
    out.push({ ...l, at: { x: l.at.x, y } });
  }
  return out;
}

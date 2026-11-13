/**
 * Where the selection's action bar sits in the viewer (docs/course-editor.md §2): centred under
 * the selection, shifted sideways only as far as it takes to stay `margin` px inside the viewer,
 * and above the selection when it does not fit below it.
 *
 * The viewer clips (`overflow: hidden`). Centred and always below, a wide bar (a long "Also in"
 * list) on a selection left of the middle began left of the viewer, its first entries cut off and
 * unclickable, and a bar under a selection near the bottom hung below it, so reaching it scrolled
 * the clipping viewer and shifted the whole map (docs/bugfix-action-bar-off-viewer.md).
 */

export interface ActionBarPlaceInput {
  /** The selection's centre in container px. */
  anchor: { x: number; y: number };
  /** Clearance from the selection's centre to the bar (the selection ring's radius) in px. */
  anchorR: number;
  /** The bar's laid-out size in px ({0, 0} before the first measure). */
  size: { w: number; h: number };
  /** The viewer's size in px. */
  container: { w: number; h: number };
  margin?: number;
  /** Gap between the selection ring and the bar. */
  gap?: number;
}

export interface ActionBarPlace {
  left: number;
  top: number;
  /** Laid out above the selection (no room below it). */
  above: boolean;
}

export function actionBarPlace({ anchor, anchorR, size, container, margin = 8, gap = 10 }: ActionBarPlaceInput): ActionBarPlace {
  const left = clampSpan(anchor.x - size.w / 2, size.w, container.w, margin);
  const below = anchor.y + anchorR + gap;
  const aboveTop = anchor.y - anchorR - gap - size.h;
  const fitsBelow = below + size.h <= container.h - margin;
  // Below unless it overflows and above fits better (more of it inside the viewer).
  const above = !fitsBelow && aboveTop >= margin;
  const top = above ? aboveTop : fitsBelow ? below : clampSpan(below, size.h, container.h, margin);
  return { left, top, above };
}

/** `start` moved as little as possible so [start, start + span] lies inside [margin, extent − margin]; the start wins when it cannot. */
function clampSpan(start: number, span: number, extent: number, margin: number): number {
  const max = extent - margin - span;
  if (max < margin) return margin;
  return Math.min(max, Math.max(margin, start));
}

/** The widest the bar may lay out: the viewer less a margin each side, never below 160 px. */
export function actionBarMaxWidth(container: number, margin = 8): number {
  return Math.max(160, container - 2 * margin);
}

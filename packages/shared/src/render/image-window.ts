/**
 * The raster window of an SVG graphic (docs/course-print.md §6.3,
 * docs/map-rendering.md §5.2 "Images"): an SVG is rasterised only over the
 * part its placements show, so a small crop of a large drawing gets the
 * full pixel box instead of a few pixels of a whole-graphic raster.
 *
 * Windows and crops are fractions of the graphic, top-left origin, like
 * the schema's `crop`. The window is the union of the crops (rounded out to
 * `WINDOW_STEP`, so nearby crops share one raster); an uncropped placement
 * makes the whole graphic the window. Isomorphic: the print composer and
 * the web texture loader both import it.
 */

export interface ImageWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Window edges are rounded out to this fraction (1/1024 of the graphic). */
export const WINDOW_STEP = 1 / 1024;

const FULL: ImageWindow = { x: 0, y: 0, width: 1, height: 1 };

/** True for the whole graphic (no window is asked). */
export function isWholeWindow(w: ImageWindow | undefined): boolean {
  return !w || (w.x <= 0 && w.y <= 0 && w.x + w.width >= 1 && w.y + w.height >= 1);
}

/** The union of the crops (an absent crop is the whole graphic), edges rounded out to `WINDOW_STEP`; `undefined` = whole. */
export function unionWindow(crops: ReadonlyArray<ImageWindow | undefined>): ImageWindow | undefined {
  if (crops.length === 0 || crops.some((c) => isWholeWindow(c))) return undefined;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const c of crops as ImageWindow[]) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + c.width);
    y1 = Math.max(y1, c.y + c.height);
  }
  const n = 1 / WINDOW_STEP;
  const ix0 = Math.max(0, Math.floor(x0 * n + 1e-9)), iy0 = Math.max(0, Math.floor(y0 * n + 1e-9));
  const ix1 = Math.min(n, Math.ceil(x1 * n - 1e-9)), iy1 = Math.min(n, Math.ceil(y1 * n - 1e-9));
  const w = { x: ix0 / n, y: iy0 / n, width: Math.max(1, ix1 - ix0) / n, height: Math.max(1, iy1 - iy0) / n };
  return isWholeWindow(w) ? undefined : w;
}

/** `crop` as a fraction of `window` (what a raster of the window shows of it); the whole crop when there is no window. */
export function cropInWindow(crop: ImageWindow | undefined, window: ImageWindow | undefined): ImageWindow | undefined {
  if (!window) return crop;
  const c = crop ?? FULL;
  return { x: (c.x - window.x) / window.width, y: (c.y - window.y) / window.height, width: c.width / window.width, height: c.height / window.height };
}

/** The `crop` query parameter of `print.png`: `x,y,w,h` in 1/1024 steps (exact decimals). */
export function windowParam(w: ImageWindow): string {
  const f = (v: number) => String(Math.round(v / WINDOW_STEP) * WINDOW_STEP);
  return [w.x, w.y, w.width, w.height].map(f).join(",");
}

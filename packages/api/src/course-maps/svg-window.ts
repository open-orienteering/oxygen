/**
 * SVG markup around an uploaded graphic (docs/course-print.md §6.3, §8.5):
 *
 * - `windowedSvg`: the graphic seen through a window of its canvas, so
 *   resvg rasterises only the part a crop shows, at the full pixel box.
 * - `trimSvgUpload`: an upload whose canvas is much larger than what it
 *   draws, re-framed to the drawing (user 2026-11-19, "Trim new uploads").
 *
 * Both wrap the original root `<svg>` unchanged but for its position and
 * size: an outer `<svg>` whose `viewBox` is the window, in the original's
 * canvas pixels (resvg's intrinsic size), holding the original as a nested
 * `<svg x=0 y=0 width=W height=H>`. The original's own viewBox,
 * `preserveAspectRatio`, namespaces, styles and fonts keep their meaning.
 */

import type { ImageWindow } from "@oxygen/shared/print";
import { BUNDLED_FONT_FILES } from "../render/fonts.js";
import { renderableSvg } from "./svg-sanitize.js";

/** Text in a logo uses the bundled faces only: the same output on every host. */
export function svgFontOptions() {
  return { loadSystemFonts: false, fontFiles: Object.values(BUNDLED_FONT_FILES).map((f) => f.path), defaultFontFamily: "Liberation Sans" };
}

const num = (v: number) => String(Math.round(v * 1e4) / 1e4);

/** The root `<svg …>` start tag at its position: attribute values may hold `>` (quotes are respected). */
const ROOT_TAG = /<svg((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

/**
 * The SVG `svg` (its canvas `canvasW × canvasH` px, as resvg reads it) seen
 * through `view` (canvas px), as a document `outW × outH` in its own units.
 * `aspect` is the outer `preserveAspectRatio` ("none" stretches to the box).
 * Everything before the root (the XML declaration, a DOCTYPE with its
 * entities, comments) stays where it is, so entity references keep
 * resolving. Throws for a root it cannot find (a prefixed `<s:svg>` too).
 */
export function reframeSvg(svg: string, canvas: [number, number], view: [x: number, y: number, w: number, h: number], out: [number, number], aspect = "none"): string {
  // The first `<svg` outside the prolog's comments and DOCTYPE.
  const masked = svg.replace(/<!--[\s\S]*?-->|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gi, (m) => " ".repeat(m.length));
  const rootStart = masked.search(/<svg[\s>/]/i);
  if (rootStart < 0) throw new Error("The SVG file has no <svg> root element");
  ROOT_TAG.lastIndex = rootStart;
  const m = ROOT_TAG.exec(svg);
  if (!m) throw new Error("The SVG root element is malformed");
  const attrs = m[1].replace(/\s(?:width|height|x|y)\s*=\s*(?:"[^"]*"|'[^']*')/g, "");
  const selfClosing = m[2] === "/";
  const root = `<svg x="0" y="0" width="${num(canvas[0])}" height="${num(canvas[1])}"${attrs}${selfClosing ? "/>" : ">"}`;
  const outer =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(out[0])}" height="${num(out[1])}"` +
    ` viewBox="${view.map(num).join(" ")}" preserveAspectRatio="${aspect}">`;
  return `${svg.slice(0, rootStart)}${outer}${root}${svg.slice(rootStart + m[0].length)}</svg>`;
}

/** `svg` over `window` (fractions of its canvas), drawn into `out` px (stretched, like the whole-graphic raster). */
export function windowedSvg(svg: string, canvas: [number, number], window: ImageWindow, out: [number, number]): string {
  const [W, H] = canvas;
  return reframeSvg(svg, canvas, [window.x * W, window.y * H, window.width * W, window.height * H], out);
}

/** A drawing smaller than its canvas by more than this fraction of a side is trimmed. */
export const TRIM_SLACK = 0.05;
/** The longer side of the raster the drawn bounds are measured on, px. */
export const TRIM_PROBE_PX = 2048;

/** The bounds of the pixels with any alpha in an RGBA raster, or null when nothing is drawn. */
export function alphaBounds(rgba: Uint8Array, width: number, height: number): [x0: number, y0: number, x1: number, y1: number] | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * An SVG upload re-framed to what it draws (user 2026-11-19): rendered at
 * `TRIM_PROBE_PX` on its longer side, the pixels with any alpha bound the
 * drawing (one probe pixel of margin each side). When that leaves more than
 * `TRIM_SLACK` of the canvas width or height empty, the SVG comes back
 * wrapped to those bounds; otherwise (or when it draws nothing, or the
 * wrapped SVG does not render as the original does) `null`, and the upload
 * is stored as it is. Runs resvg synchronously: the API calls it in a print
 * worker (`trimSvgInWorker`), never on the event loop.
 */
export async function trimSvgUpload(upload: Buffer): Promise<Buffer | null> {
  const { Resvg } = await import("@resvg/resvg-js");
  // Measured and re-framed from the validated tree's serialisation, not the uploaded bytes.
  const svg = renderableSvg(upload);
  if (!svg) return null;
  const text = svg.toString("utf8");
  const font = svgFontOptions();
  const probe = new Resvg(svg, { font });
  const W = probe.width, H = probe.height;
  if (!(W > 0) || !(H > 0)) return null;
  const r = new Resvg(svg, { fitTo: W >= H ? { mode: "width", value: TRIM_PROBE_PX } : { mode: "height", value: TRIM_PROBE_PX }, font });
  const img = r.render();
  const b = alphaBounds(new Uint8Array(img.pixels), img.width, img.height);
  if (!b) return null;
  const px = [Math.max(0, b[0] - 1), Math.max(0, b[1] - 1), Math.min(img.width, b[2] + 1), Math.min(img.height, b[3] + 1)];
  const sx = W / img.width, sy = H / img.height;
  const view: [number, number, number, number] = [px[0] * sx, px[1] * sy, (px[2] - px[0]) * sx, (px[3] - px[1]) * sy];
  if (view[2] >= W * (1 - TRIM_SLACK) && view[3] >= H * (1 - TRIM_SLACK)) return null;
  let trimmed: Buffer;
  try {
    trimmed = Buffer.from(reframeSvg(text, [W, H], view, [view[2], view[3]], "xMidYMid meet"), "utf8");
    // Accepted only if resvg reads it and it still draws (the original is stored otherwise).
    const check = new Resvg(trimmed, { fitTo: { mode: "width", value: 64 }, font }).render();
    if (!alphaBounds(new Uint8Array(check.pixels), check.width, check.height)) return null;
  } catch {
    return null;
  }
  return trimmed;
}

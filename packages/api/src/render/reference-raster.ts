/**
 * Reference raster: pass stream → SVG (shared serialiser) → RGBA via
 * resvg. This is the oracle image of the golden-image tier
 * (docs/map-rendering.md §6.2); the WebGL2 and PDF backends are compared
 * against it, never against each other.
 *
 * Deliberately simple: no caching, no semaphore, test and tooling use
 * only. Production rendering never goes through here.
 */

import { render } from "@oxygen/shared";

export interface ReferenceRasterOptions {
  colour: (idx: number) => string;
  /** Paper area, µm. Default: stream bounds + margin. */
  bounds?: render.Bounds;
  marginUm?: number;
  /** Output density. Default 10 px/mm (254 dpi). */
  pxPerMm?: number;
  background?: string;
  glyphOutline?: render.ReferenceSvgOptions["glyphOutline"];
}

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  pixels: Uint8Array;
  /** Paper rectangle the image covers, µm. */
  bounds: render.Bounds;
  svg: string;
}

export async function rasterisePassStream(stream: render.PassStream, opts: ReferenceRasterOptions): Promise<RasterImage> {
  const margin = opts.marginUm ?? 1000;
  const raw = opts.bounds ?? render.passStreamBounds(stream) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const bounds: render.Bounds = opts.bounds
    ? raw
    : { minX: raw.minX - margin, minY: raw.minY - margin, maxX: raw.maxX + margin, maxY: raw.maxY + margin };
  const svg = render.passStreamToSvg(stream, { ...opts, bounds, marginUm: 0 });
  const { renderAsync } = await import("@resvg/resvg-js");
  const widthPx = Math.max(1, Math.round(((bounds.maxX - bounds.minX) / 1000) * (opts.pxPerMm ?? 10)));
  const rendered = await renderAsync(svg, { fitTo: { mode: "width", value: widthPx } });
  return {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8Array(rendered.pixels.buffer, rendered.pixels.byteOffset, rendered.pixels.byteLength),
    bounds,
    svg,
  };
}

/** RGBA at a paper coordinate (µm, y-up). Returns undefined outside the image. */
export function sampleAt(img: RasterImage, xUm: number, yUm: number): [number, number, number, number] | undefined {
  const fx = (xUm - img.bounds.minX) / (img.bounds.maxX - img.bounds.minX);
  const fy = (img.bounds.maxY - yUm) / (img.bounds.maxY - img.bounds.minY);
  const px = Math.floor(fx * img.width);
  const py = Math.floor(fy * img.height);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return undefined;
  const o = (py * img.width + px) * 4;
  return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]];
}

export interface ImageDiff {
  /** Pixels whose max channel difference exceeds `channelTolerance`. */
  differing: number;
  total: number;
  /** Fraction of differing pixels, 0..1. */
  ratio: number;
}

/**
 * Pixel comparison of two same-sized RGBA images. Anti-aliasing differs
 * between rasterisers, so the golden tier passes when `ratio` is under a
 * per-fixture budget rather than demanding equality.
 */
export function diffImages(
  a: { width: number; height: number; pixels: Uint8Array },
  b: { width: number; height: number; pixels: Uint8Array },
  channelTolerance = 16,
): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`image size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a.pixels[o] - b.pixels[o]),
      Math.abs(a.pixels[o + 1] - b.pixels[o + 1]),
      Math.abs(a.pixels[o + 2] - b.pixels[o + 2]),
      Math.abs(a.pixels[o + 3] - b.pixels[o + 3]),
    );
    if (d > channelTolerance) differing++;
  }
  return { differing, total, ratio: total === 0 ? 0 : differing / total };
}

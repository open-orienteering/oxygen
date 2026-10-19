/**
 * Symbol swatches (docs/map-rendering.md §5.1.1; research 06 §5.2): one
 * `RenderSymbol` in isolation on a fixed sample object, so a document's
 * source symbol and a canonical library entry are drawn by the same code
 * and a reviewer compares like with like. The scene is ordinary
 * `RenderObject`s through `symbolise` — nothing about the symbol is
 * special-cased. Pure; the reference raster draws the result.
 */

import { COORD_FLAG, type PassStream, makePath } from "./pass-stream.js";
import { type Bounds, unionBounds } from "./path.js";
import { passStreamBounds } from "./reference-svg.js";
import type { RenderSymbol } from "./symbol.js";
import { type RenderObject, type SymboliseWarning, symbolise } from "./symbolise.js";
import { scaleRenderSymbol } from "./transform.js";
import type { FontMetrics } from "./truetype.js";

export const SWATCH = {
  /** Output density, the golden density. */
  pxPerMm: 10,
  marginUm: 1000,
  /** Light neutral grey: white ink, halos and knock-outs stay visible. */
  background: "#f0f0f0",
  pointScale: 3,
  /** Minimum frame side for a point swatch, centred on the point. */
  pointFrameUm: 12000,
  areaSideUm: 15000,
  text: "Abc 123",
} as const;

/**
 * 30 mm: 12 mm east to a corner, then 18 mm at 30° with a dash point
 * 10 mm after the corner. Integer µm; the arc length is 30 mm to within
 * rounding.
 */
const LINE_COORDS = [0, 0, 12000, 0, 20660, 5000, 27588, 9000];
const LINE_FLAGS = [0, COORD_FLAG.corner, COORD_FLAG.dash, 0];

export interface SwatchScene {
  objects: RenderObject[];
  symbols: RenderSymbol[];
  /** The kind's minimum frame, µm; `null` when the stream alone decides (text). */
  minFrame: Bounds | null;
}

export function swatchScene(symbol: RenderSymbol): SwatchScene {
  switch (symbol.type) {
    case "point": {
      const h = SWATCH.pointFrameUm / 2;
      return {
        objects: [{ symbolIdx: 0, path: makePath([0, 0]) }],
        symbols: [scaleRenderSymbol(symbol, SWATCH.pointScale)],
        minFrame: { minX: -h, minY: -h, maxX: h, maxY: h },
      };
    }
    case "line": {
      const path = makePath(LINE_COORDS, LINE_FLAGS);
      return { objects: [{ symbolIdx: 0, path }], symbols: [symbol], minFrame: boundsOf(LINE_COORDS) };
    }
    case "area": {
      const s = SWATCH.areaSideUm;
      const coords = [0, 0, s, 0, s, s, 0, s];
      return { objects: [{ symbolIdx: 0, path: makePath(coords, undefined, true) }], symbols: [symbol], minFrame: boundsOf(coords) };
    }
    case "text":
      return { objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: SWATCH.text }], symbols: [symbol], minFrame: null };
  }
}

export interface SwatchFrame {
  /** Paper rectangle the image covers, µm — a whole number of pixels on each axis. */
  bounds: Bounds;
  width: number;
  height: number;
}

/** Union of the minimum frame and the stream's bounds, plus the margin, grown symmetrically to whole pixels. */
export function swatchFrame(minFrame: Bounds | null, stream: PassStream): SwatchFrame {
  const s = passStreamBounds(stream);
  const raw = s && minFrame ? unionBounds(s, minFrame) : (s ?? minFrame ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const m = SWATCH.marginUm;
  const umPerPx = 1000 / SWATCH.pxPerMm;
  const width = Math.max(1, Math.ceil((raw.maxX - raw.minX + 2 * m) / umPerPx - 1e-9));
  const height = Math.max(1, Math.ceil((raw.maxY - raw.minY + 2 * m) / umPerPx - 1e-9));
  const padX = (width * umPerPx - (raw.maxX - raw.minX)) / 2;
  const padY = (height * umPerPx - (raw.maxY - raw.minY)) / 2;
  return {
    bounds: { minX: raw.minX - padX, minY: raw.minY - padY, maxX: raw.maxX + padX, maxY: raw.maxY + padY },
    width,
    height,
  };
}

export interface SymbolisedSwatch {
  stream: PassStream;
  warnings: SymboliseWarning[];
  frame: SwatchFrame;
}

/** Scene → `symbolise` → frame: everything a backend needs to draw the swatch. */
export function symboliseSwatch(symbol: RenderSymbol, fonts: FontMetrics[]): SymbolisedSwatch {
  const scene = swatchScene(symbol);
  const { stream, warnings } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts });
  return { stream, warnings, frame: swatchFrame(scene.minFrame, stream) };
}

function boundsOf(coords: number[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    minX = Math.min(minX, coords[i]); maxX = Math.max(maxX, coords[i]);
    minY = Math.min(minY, coords[i + 1]); maxY = Math.max(maxY, coords[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

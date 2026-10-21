/**
 * The golden-image scene list (docs/map-rendering.md §6.2): the six
 * contract fixtures, the pilot scene and the library fixtures (04 §8
 * rows 1–9, colour order, precision), each resolved to a pass stream
 * and a colour lookup the same way on every side — the reference raster
 * that writes the goldens and the browser page the WebGL2 backend draws
 * into. Density and margin are fixed here so canvas and raster agree on
 * the pixel grid.
 */

import type { FontMetrics } from "../truetype.js";
import type { PassStream } from "../pass-stream.js";
import { cmykToHex } from "../symbol.js";
import { passStreamBounds } from "../reference-svg.js";
import { passStreamFromJson } from "../stream-json.js";
import { symbolise } from "../symbolise.js";
import { fixtureColours, renderFixtures, type RenderFixtureName } from "./streams/index.js";
import { pilotColours, pilotSymbols } from "./pilot-symbols.js";
import { pilotScene } from "./pilot-scene.js";
import { type LibrarySceneName, isLibrarySceneName, libraryScene, librarySceneNames } from "./library/index.js";

export type GoldenSceneName = RenderFixtureName | "pilot-scene" | LibrarySceneName;

export const goldenSceneNames: GoldenSceneName[] = [
  ...(Object.keys(renderFixtures) as RenderFixtureName[]),
  "pilot-scene",
  ...librarySceneNames,
];

export const GOLDEN_PX_PER_MM = 10;
export const GOLDEN_MARGIN_UM = 1000;

export interface GoldenScene {
  name: GoldenSceneName;
  stream: PassStream;
  colour: (idx: number) => string;
}

export function goldenScene(name: GoldenSceneName, fonts: FontMetrics[]): GoldenScene {
  if (isLibrarySceneName(name)) {
    const scene = libraryScene(name);
    const { stream } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts });
    const hex = scene.colours.map((c) => cmykToHex(c.cmyk));
    return { name, stream, colour: (i) => hex[i] ?? "#ff00ff" };
  }
  if (name === "pilot-scene") {
    const { stream } = symbolise({ objects: pilotScene, symbols: pilotSymbols, fonts });
    return { name, stream, colour: (i) => pilotColours[i]?.hex ?? "#ff00ff" };
  }
  return {
    name,
    stream: passStreamFromJson(renderFixtures[name]),
    colour: (i) => fixtureColours[i] ?? "#ff00ff",
  };
}

export interface GoldenFrame {
  /** Paper rectangle the image covers, µm — a whole number of pixels on each axis. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
}

/**
 * The image frame of a golden scene: stream bounds plus the margin,
 * grown symmetrically to a whole number of golden pixels so neither side
 * has to deal with a fractional viewBox edge.
 */
export function goldenFrame(stream: PassStream): GoldenFrame {
  const raw = passStreamBounds(stream) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const m = GOLDEN_MARGIN_UM;
  const umPerPx = 1000 / GOLDEN_PX_PER_MM;
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

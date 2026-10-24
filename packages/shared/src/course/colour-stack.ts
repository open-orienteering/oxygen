/**
 * The course layer's colour stack (docs/course-layer.md §1): the
 * document's aligned stack, completed with the "Upper white for course
 * overprint" row when the document lacks it, and with one row per colour
 * of a hex-coloured layout object on top.
 */

import type { DocumentColour } from "../map-document/header.js";
import { paletteIndexOfStack } from "../import/colour-align.js";
import { iof2024Palette } from "../symbol-library/palette.js";

export class CourseStackError extends Error {}

export interface CourseColourStack {
  colours: DocumentColour[];
  /** Document index → new index; `null` = unchanged. */
  remap: number[] | null;
  /** Palette id → index in `colours`. */
  index: Map<string, number>;
}

/**
 * Upper white is a row of the IOF table for ISSprOM, ISSkiOM and ISMTBOM
 * but not for ISOM (03 Appendix B), so no ISOM document has it; the
 * course layer needs it for white-outs and number outlines, directly
 * below upper purple (§1).
 */
export function courseColourStack(colours: readonly DocumentColour[]): CourseColourStack {
  const index = paletteIndexOfStack(colours);
  const upper = index.get("purple-upper");
  if (upper === undefined || !index.has("purple-lower")) {
    throw new CourseStackError("document colour stack is not aligned (no lower / upper purple); re-match the document");
  }
  if (index.has("white-upper")) return { colours: [...colours], remap: null, index };
  const white = iof2024Palette.find((p) => p.id === "white-upper")!;
  const out = [...colours];
  out.splice(upper, 0, { id: "iof2024:white-upper", name: white.name, cmyk: [...white.cmyk], paletteIds: ["white-upper"] });
  const remap = colours.map((_, i) => (i < upper ? i : i + 1));
  return { colours: out, remap, index: paletteIndexOfStack(out) };
}

/** Naive sRGB → CMYK, the inverse of `cmykToHex` (03 §2.3). */
export function hexToCmyk(hex: string): [number, number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const c = (x: number) => Math.round(((1 - x - k) / (1 - k)) * 10000) / 10000;
  return [c(r), c(g), c(b), Math.round(k * 10000) / 10000];
}

/**
 * Rows for the colours of hex-coloured layout objects, appended on top in
 * first-use order: legacy print draws those objects after everything else.
 */
export function withObjectColours(colours: readonly DocumentColour[], hexes: readonly string[]): { colours: DocumentColour[]; indexOf: (hex: string) => number } {
  const out = [...colours];
  const at = new Map<string, number>();
  for (const raw of hexes) {
    const hex = raw.toLowerCase();
    if (at.has(hex)) continue;
    at.set(hex, out.length);
    out.push({ id: `course-object:${hex}`, name: `Layout ${hex}`, cmyk: hexToCmyk(hex) });
  }
  return {
    colours: out,
    indexOf: (hex) => {
      const i = at.get(hex.toLowerCase());
      if (i === undefined) throw new Error(`colour ${hex} was not registered`);
      return i;
    },
  };
}

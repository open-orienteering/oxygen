/**
 * WebGL2 backend, text atlas build: what `scripts/generate-text-atlas.ts`
 * feeds `msdf-atlas-gen` and how its JSON becomes a committed page
 * (docs/map-rendering.md §4.10). Pure; the script does the I/O and runs
 * the generator, this module is what the unit tests cover.
 */

import type { render } from "@oxygen/shared";
import { TEXT_ATLAS_PAGE_RANGES, type TextAtlasFace, type TextAtlasPage, type TextAtlasPageName } from "./text-atlas.js";

/** Generator settings (S1 §5: 32 px per em; 04 §6.7). The distance range is 8 px = 0.25 em. */
export const TEXT_ATLAS_EM_PX = 32;
export const TEXT_ATLAS_RANGE_PX = 8;

/** Glyph ids the font maps a code point of the page's ranges to, ascending, without `.notdef`. */
export function pageGlyphIds(font: Pick<render.FontMetrics, "glyphId">, page: TextAtlasPageName): number[] {
  const ids = new Set<number>();
  for (const [lo, hi] of TEXT_ATLAS_PAGE_RANGES[page]) {
    for (let cp = lo; cp <= hi; cp++) {
      const g = font.glyphId(cp);
      if (g) ids.add(g);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** `msdf-atlas-gen -glyphset` file contents for a list of glyph ids. */
export function glyphsetFile(ids: number[]): string {
  return ids.join(", ") + "\n";
}

interface RawBounds { left: number; bottom: number; right: number; top: number }
interface RawGlyph { index?: number; unicode?: number; advance: number; planeBounds?: RawBounds; atlasBounds?: RawBounds }
interface RawVariant { name?: string; glyphs: RawGlyph[] }
/** The part of `msdf-atlas-gen -json` output the page needs (`-yorigin top`, glyph indices). */
export interface RawAtlasJson {
  atlas: { type: string; distanceRange: number; size: number; width: number; height: number; yOrigin: string };
  variants?: RawVariant[];
  glyphs?: RawGlyph[];
}

/**
 * The committed page from the generator's JSON: one face per variant, in
 * the order the fonts were passed. Empty glyphs (space) have no bounds and
 * are left out — the backend draws nothing for an id it does not find.
 */
export function pageFromAtlasJson(
  raw: RawAtlasJson,
  page: TextAtlasPageName,
  faces: Omit<TextAtlasFace, "glyphs">[],
): TextAtlasPage {
  const a = raw.atlas;
  if (a.type !== "mtsdf") throw new Error(`atlas type ${a.type}, expected mtsdf`);
  if (a.yOrigin !== "top") throw new Error(`atlas yOrigin ${a.yOrigin}, expected top`);
  const variants: RawVariant[] = raw.variants ?? [{ glyphs: raw.glyphs ?? [] }];
  if (variants.length !== faces.length) throw new Error(`atlas has ${variants.length} fonts, expected ${faces.length}`);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    version: 1,
    page,
    width: a.width,
    height: a.height,
    emPx: a.size,
    distanceRangePx: a.distanceRange,
    faces: faces.map((f, i) => {
      const glyphs: number[] = [];
      const sorted = [...variants[i].glyphs].sort((x, y) => (x.index ?? -1) - (y.index ?? -1));
      for (const g of sorted) {
        if (g.index === undefined) throw new Error("atlas glyph without index: run the generator with -glyphset");
        if (!g.planeBounds || !g.atlasBounds) continue;
        const p = g.planeBounds, q = g.atlasBounds;
        // yOrigin top flips both: atlas top < bottom (px, y-down, kept), plane bounds y-down (em, turned y-up).
        glyphs.push(g.index, r6(p.left), r6(-p.bottom), r6(p.right), r6(-p.top), q.left, q.top, q.right, q.bottom);
      }
      return { ...f, glyphs };
    }),
  };
}

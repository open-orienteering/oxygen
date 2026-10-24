/**
 * WebGL2 backend, text atlas: the committed MTSDF pages of the bundled
 * fonts (docs/map-rendering.md §4.10, §5.2 "Text atlas") and what the
 * worker and the renderer derive from them.
 *
 * A page holds all three faces (Liberation Sans Regular, Narrow, Bold) at
 * 32 px per em with an 8 px distance range: RGB a multi-channel signed
 * distance field (sharp corners for the fill), A the true signed
 * distance (the halo band). Glyphs are keyed by font **glyph id** — what
 * a `TextPass` carries — not by code point. The Latin page is always
 * loaded; the Cyrillic page only when the document's strings need it
 * (S1 §5).
 *
 * The page images and this JSON are session assets, not document
 * assets: the worker builds a (family, glyph id) → entry lookup, the
 * renderer uploads the images and a float table of every entry.
 *
 * Pure TypeScript.
 */

import type { render } from "@oxygen/shared";

export type TextAtlasPageName = "latin" | "cyrillic";

/**
 * Code point ranges per page, inclusive. Latin: ASCII, Latin-1
 * Supplement, Latin Extended-A (S1 §5) plus general punctuation
 * (dashes, quotes, bullet, ellipsis) and the euro sign. Cyrillic: the
 * Cyrillic block; glyphs already on the Latin page are not repeated.
 */
export const TEXT_ATLAS_PAGE_RANGES: Record<TextAtlasPageName, [number, number][]> = {
  latin: [[0x20, 0x7e], [0xa0, 0x17f], [0x2010, 0x2027], [0x20ac, 0x20ac]],
  cyrillic: [[0x400, 0x4ff]],
};

/** Page order: the index is the page's slot in the renderer and in the text range table's `group`. */
export const TEXT_ATLAS_PAGE_NAMES: readonly TextAtlasPageName[] = ["latin", "cyrillic"];

export interface TextAtlasFace {
  family: render.FontFamily;
  /** The bold face of the family (`head.macStyle` bit 0); absent = regular. */
  bold?: boolean;
  /** SHA-256 (hex) of the TTF the page was generated from. */
  sha256: string;
  unitsPerEm: number;
  /**
   * Nine numbers per glyph, ascending glyph id: id, plane bounds left,
   * bottom, right, top (em, y-up, relative to the glyph origin; the quad
   * includes half the distance range), atlas bounds left, top, right,
   * bottom (px, y-down, top-left origin).
   */
  glyphs: number[];
}

/** One committed page (`packages/shared/fonts/msdf/text-atlas.<page>.json`). */
export interface TextAtlasPage {
  version: 1;
  page: TextAtlasPageName;
  width: number;
  height: number;
  /** Atlas pixels per em. */
  emPx: number;
  /** Distance range, atlas px: a channel value of 0 / 1 is half of it outside / inside the edge. */
  distanceRangePx: number;
  faces: TextAtlasFace[];
}

export const TEXT_GLYPH_STRIDE = 9;

/** The atlas pages a document needs: Latin always, Cyrillic when any string has a Cyrillic code point. */
export function textAtlasPagesFor(strings: readonly string[]): TextAtlasPageName[] {
  const pages: TextAtlasPageName[] = ["latin"];
  const [[lo, hi]] = TEXT_ATLAS_PAGE_RANGES.cyrillic;
  if (strings.some((s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= lo && c <= hi) return true; } return false; })) {
    pages.push("cyrillic");
  }
  return pages;
}

/** Runtime check of a fetched page (the JSON crosses a network and a worker boundary). */
export function parseTextAtlasPage(v: unknown): TextAtlasPage {
  const p = v as Partial<TextAtlasPage> | null;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (
    !p || p.version !== 1 || !TEXT_ATLAS_PAGE_NAMES.includes(p.page as TextAtlasPageName) ||
    !num(p.width) || !num(p.height) || !num(p.emPx) || !num(p.distanceRangePx) || !Array.isArray(p.faces) ||
    !p.faces.every((f) => f && typeof f.family === "string" && (f.bold === undefined || typeof f.bold === "boolean") && num(f.unitsPerEm) && Array.isArray(f.glyphs) && f.glyphs.length % TEXT_GLYPH_STRIDE === 0)
  ) {
    throw new Error("not a text atlas page");
  }
  return p as TextAtlasPage;
}

/** Floats per glyph-table entry: four RGBA32F texels. */
export const GLYPH_TABLE_TEXELS = 4;
/** Texels per row of the glyph-table texture (256 entries). */
export const GLYPH_TABLE_WIDTH = 1024;

export interface TextGlyph {
  /** Row of the glyph table (the instance's `entry`). */
  entry: number;
  /** Index into the pages the lookup was built from. */
  page: number;
}

/** `${family}[/bold]/${glyphId}` → entry, over pages in the given order (the first page holding a glyph wins). */
export type TextGlyphLookup = Map<string, TextGlyph>;

export const textGlyphKey = (family: string, bold: boolean | undefined, glyphId: number) => `${family}${bold ? "/bold" : ""}/${glyphId}`;

/**
 * Entries of every glyph of `pages` in order, and the table the renderer
 * uploads: per entry plane l, b, r, t (em) · uv u0, v0, u1, v1 (v0 top) ·
 * page, range (em), 0, 0 · 0, 0, 0, 0. The worker uses only the lookup;
 * both sides build it from the same pages in the same order, so entries
 * agree.
 */
export function buildTextGlyphs(pages: readonly TextAtlasPage[]): { lookup: TextGlyphLookup; table: Float32Array; entries: number } {
  const lookup: TextGlyphLookup = new Map();
  let entries = 0;
  for (const p of pages) for (const f of p.faces) entries += f.glyphs.length / TEXT_GLYPH_STRIDE;
  const rows = Math.max(1, Math.ceil((entries * GLYPH_TABLE_TEXELS) / GLYPH_TABLE_WIDTH));
  const table = new Float32Array(rows * GLYPH_TABLE_WIDTH * 4);
  let e = 0;
  pages.forEach((p, pi) => {
    const rangeEm = p.distanceRangePx / p.emPx;
    for (const f of p.faces) {
      const g = f.glyphs;
      for (let i = 0; i < g.length; i += TEXT_GLYPH_STRIDE, e++) {
        const key = textGlyphKey(f.family, f.bold, g[i]);
        if (!lookup.has(key)) lookup.set(key, { entry: e, page: pi });
        const o = e * GLYPH_TABLE_TEXELS * 4;
        table.set([g[i + 1], g[i + 2], g[i + 3], g[i + 4]], o);
        table.set([g[i + 5] / p.width, g[i + 6] / p.height, g[i + 7] / p.width, g[i + 8] / p.height], o + 4);
        table.set([pi, rangeEm, 0, 0], o + 8);
      }
    }
  });
  return { lookup, table, entries };
}

/**
 * A halo's half width in em for the shader, clamped to what the distance
 * field holds (half the range: beyond it the field is saturated).
 */
export function haloEm(haloWidthUm: number, sizeUm: number, rangeEm: number): { em: number; clamped: boolean } {
  const em = haloWidthUm / sizeUm;
  const max = rangeEm / 2;
  return em > max ? { em: max, clamped: true } : { em, clamped: false };
}

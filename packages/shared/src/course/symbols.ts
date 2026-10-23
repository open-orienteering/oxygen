/**
 * The course symbols (docs/course-layer.md §3.1): the library's 7xx
 * entries resolved against the document's aligned stack exactly like the
 * render bridge resolves a canonical entry, scaled by the document factor,
 * then by the appearance multipliers.
 */

import { CONTROL_NUMBER_CAP_HEIGHT_RATIO } from "../course-maps/course-overlay-svg.js";
import type { Glyph, GlyphPart, LineSymbol, PointSymbol, RenderSymbol, TextSymbol } from "../render/symbol.js";
import { parseRenderSymbol } from "../render/symbol.js";
import { scaleRenderSymbol } from "../render/transform.js";
import { type SymbolLibraryId, getLibraryEntry } from "../symbol-library/index.js";
import { resolveEntry } from "../symbol-library/schema.js";
import type { CourseAppearance, CourseDocumentContext } from "./types.js";

/** Indices into `CourseSymbolSet.symbols`. */
export interface CourseSymbolIdx {
  start: number;
  /** 703 as a line symbol, so its circle can be gapped. */
  circle: number;
  finish: number;
  number: number;
  leader: number;
  leg: number;
  markedRoute: number;
  restrictedLine: number;
  forbiddenRoute: number;
  oobArea: number;
  oobAreaBorder: number;
  whiteout: number;
}

export interface CourseSymbolSet {
  symbols: RenderSymbol[];
  idx: CourseSymbolIdx;
  /** 703 centre-line radius, µm. */
  circleRadiusUm: number;
  /** 706 outer ring centre-line radius, µm. */
  finishRadiusUm: number;
  /** 701 circumradius (centroid to apex), µm. */
  startRadiusUm: number;
  /** 704 digit height and em size, µm. */
  digitHeightUm: number;
  numberEmUm: number;
  /** 705 width, µm. */
  lineWidthUm: number;
}

const BORROW: Partial<Record<string, string>> = {
  // ISSprOM has no out-of-bounds route; imported sprint courses may still carry one.
  "ISSprOM2019-2:711": "ISOM2017-2:711",
};

/** 704 em per digit height for Liberation Sans (the legacy overlay's ratio). */
const EM_PER_DIGIT = 1 / CONTROL_NUMBER_CAP_HEIGHT_RATIO;
const KNOCKOUT_OUTLINE_UM = 150;

function resolveCode(libraryId: SymbolLibraryId, code: string, index: ReadonlyMap<string, number>, factor: number): RenderSymbol {
  const id = `${libraryId}:${code}`;
  const entry = getLibraryEntry(id) ?? getLibraryEntry(BORROW[id] ?? "");
  if (!entry) throw new Error(`symbol library ${libraryId} has no entry ${code}`);
  return scaleRenderSymbol(resolveEntry(entry, index), factor);
}

/** Glyph geometry × `geom`, stroke widths × `width`; a ring keeps its centre-line diameter × `geom`. */
function scaleGlyph(g: Glyph, geom: number, width: number): Glyph {
  const part = (p: GlyphPart): GlyphPart => {
    const out: GlyphPart = { ...p };
    if (p.widthUm !== undefined) out.widthUm = p.widthUm * width;
    if (p.kind === "ring" && p.diameterUm !== undefined) out.diameterUm = (p.diameterUm - (p.widthUm ?? 0)) * geom + (out.widthUm ?? 0);
    else if (p.diameterUm !== undefined) out.diameterUm = p.diameterUm * geom;
    if (p.cx !== undefined) out.cx = p.cx * geom;
    if (p.cy !== undefined) out.cy = p.cy * geom;
    if (p.geometry) out.geometry = { ...p.geometry, coords: p.geometry.coords.map((c) => c * geom) };
    return out;
  };
  return { ...g, parts: g.parts.map(part) };
}

function scaleLineWidths(sym: LineSymbol, width: number): LineSymbol {
  if (width === 1) return sym;
  return {
    ...sym,
    ...(sym.main ? { main: { ...sym.main, widthUm: sym.main.widthUm * width } } : {}),
    ...(sym.glyphs ? { glyphs: sym.glyphs.map((g) => ({ ...g, glyph: scaleGlyph(g.glyph, 1, width) })) } : {}),
  };
}

function ringOf(sym: PointSymbol): GlyphPart {
  const ring = sym.glyph.parts.filter((p) => p.kind === "ring").sort((a, b) => (b.diameterUm ?? 0) - (a.diameterUm ?? 0))[0];
  if (!ring?.diameterUm || !ring.widthUm) throw new Error(`${sym.id}: no ring part`);
  return ring;
}

/** The resolved course symbols for one document, stack and appearance. */
export function courseSymbols(doc: Pick<CourseDocumentContext, "libraryId" | "documentFactor">, index: ReadonlyMap<string, number>, appearance: CourseAppearance): CourseSymbolSet {
  const c = appearance.circle ?? 1, l = appearance.line ?? 1, n = appearance.number ?? 1;
  const get = (code: string) => resolveCode(doc.libraryId, code, index, doc.documentFactor);
  const point = (code: string): PointSymbol => {
    const s = get(code) as PointSymbol;
    return { ...s, glyph: scaleGlyph(s.glyph, c, l) };
  };
  const line = (code: string): LineSymbol => scaleLineWidths(get(code) as LineSymbol, l);

  const start = point("701");
  const control = point("703");
  const finish = point("706");
  const ring = ringOf(control);
  const circle = parseRenderSymbol({
    type: "line", id: `${control.id}/arc`, code: control.code, name: control.name,
    main: { colour: ring.colour, widthUm: ring.widthUm!, cap: "flat", join: "round" },
  }) as LineSymbol;

  let number = get("704") as TextSymbol;
  if (appearance.numberStyle === "knockout") {
    const upper = index.get("purple-upper")!, white = index.get("white-upper");
    if (white === undefined) throw new Error("knockout numbers need the upper white row (courseColourStack)");
    number = { ...number, colour: upper, halo: { colour: white, widthUm: KNOCKOUT_OUTLINE_UM * doc.documentFactor } };
  }
  const digitHeightUm = (number.digitHeightUm ?? number.fontSizeUm / EM_PER_DIGIT) * n;
  number = { ...number, align: "centre", fontSizeUm: number.fontSizeUm * n, ...(number.digitHeightUm ? { digitHeightUm } : {}) };

  const leg = line("705");
  const leader = { ...leg, id: `${leg.id}/leader`, main: { ...leg.main!, colour: number.colour, widthUm: leg.main!.widthUm * 0.7 } } satisfies LineSymbol;
  const oobArea = get("709");
  const oobAreaBorder = get("709.b");
  const whiteout = parseRenderSymbol({ type: "area", id: "course:whiteout", code: "whiteout", name: "White-out", fill: index.get("white-upper") });

  const symbols: RenderSymbol[] = [start, circle, finish, number, leader, leg, line("707"), line("708"), line("711"), oobArea, oobAreaBorder, whiteout];
  const startPart = start.glyph.parts[0];
  return {
    symbols,
    idx: { start: 0, circle: 1, finish: 2, number: 3, leader: 4, leg: 5, markedRoute: 6, restrictedLine: 7, forbiddenRoute: 8, oobArea: 9, oobAreaBorder: 10, whiteout: 11 },
    circleRadiusUm: (ring.diameterUm! - ring.widthUm!) / 2,
    finishRadiusUm: ((ringOf(finish).diameterUm ?? 0) - (ringOf(finish).widthUm ?? 0)) / 2,
    startRadiusUm: startPart.geometry ? Math.hypot(startPart.geometry.coords[0], startPart.geometry.coords[1]) : 0,
    digitHeightUm,
    numberEmUm: digitHeightUm * EM_PER_DIGIT,
    lineWidthUm: leg.main!.widthUm,
  };
}

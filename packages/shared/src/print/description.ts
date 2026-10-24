/**
 * The IOF description block as page-layer objects (docs/course-print.md
 * §6.2; research 05 §5.6): rules and text through the shared shaper, the
 * pictograms as glyphs converted from `iof-symbols.ts` path data, so a
 * pictogram used on many pages is one form XObject in the PDF. Geometry
 * is the legacy SVG block's (`description-svg.ts`), formula for formula.
 *
 * Output coordinates: page µm, y-up (`paperHeightMm` flips the block's
 * y-down page mm).
 */

import { IOF_SYMBOLS, descriptionCells, type DescriptionCell } from "../course-maps/iof-symbols.js";
import { DESCRIPTION_THICK_COLUMNS, hasThickRuleBelow, type DescriptionSheetHeader, type DescriptionSheetRow } from "../course-maps/description-rows.js";
import type { DescriptionRow } from "../course-maps/description-svg.js";
import { COORD_FLAG, makePath } from "../render/pass-stream.js";
import { type Glyph, type GlyphPart, type RenderSymbol, parseRenderSymbol } from "../render/symbol.js";
import type { RenderObject } from "../render/symbolise.js";

/** One SVG unit of the pictogram data (viewBox −100…100) in glyph µm: 200 units = 20 mm. */
export const PICTOGRAM_UNIT_UM = 100;
/** Legacy rule widths, mm. */
const THIN_MM = 0.15;
const THICK_MM = 0.35;

export interface DescriptionBlockInput {
  /** Top-left corner, page mm (y-down). */
  x: number;
  y: number;
  cellSizeMm: number;
  rows: DescriptionRow[];
  /** Three-row IOF header; absent → one title row with `title`. */
  header?: DescriptionSheetHeader | null;
  title: string;
  /** Ink colour, default black. */
  colour?: string;
}

const attr = (el: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];

/** SVG `d` (absolute M / L / C / Z, the only commands the data uses) → glyph coords, y flipped. */
function pathGeometry(d: string): { coords: number[]; flags: number[]; closed: boolean } {
  const tokens = d.match(/[MLCZmlcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const coords: number[] = [];
  const flags: number[] = [];
  let closed = false;
  let cmd = "";
  const num = (i: number) => Number(tokens[i]);
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") closed = true;
      continue;
    }
    const pt = (x: number, y: number, flag: number) => {
      coords.push(x * PICTOGRAM_UNIT_UM, -y * PICTOGRAM_UNIT_UM);
      flags.push(flag);
    };
    if (cmd === "M" || cmd === "L") {
      pt(num(i), num(i + 1), 0);
      i += 2;
    } else if (cmd === "C") {
      pt(num(i), num(i + 1), COORD_FLAG.bezierFirst);
      pt(num(i + 2), num(i + 3), COORD_FLAG.bezierSecond);
      pt(num(i + 4), num(i + 5), 0);
      i += 6;
    } else {
      throw new Error(`unsupported path command ${cmd} in pictogram data`);
    }
  }
  // A closed ring that repeats its first point needs no closing point.
  const n = coords.length;
  if (closed && n >= 4 && coords[0] === coords[n - 2] && coords[1] === coords[n - 1]) {
    coords.length = n - 2;
    flags.length = flags.length - 1;
  }
  return { coords, flags, closed };
}

/** Glyph geometry, widths, diameters and centres × `k` (rounded to µm). */
function scaleGlyph(g: Glyph, k: number): Glyph {
  const r = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * k));
  return {
    ...g,
    parts: g.parts.map((p) => {
      const out: GlyphPart = { ...p };
      for (const f of ["widthUm", "diameterUm", "cx", "cy"] as const) if (p[f] !== undefined) out[f] = r(p[f]);
      if (p.geometry) out.geometry = { ...p.geometry, coords: p.geometry.coords.map((c) => Math.round(c * k)) };
      return out;
    }),
  };
}

const glyphCache = new Map<string, Glyph | null>();

/**
 * The pictogram of an `IOF_SYMBOLS` key as a glyph (colour index 0, glyph
 * µm, y-up, centred on the origin like the data's viewBox): `fill="black"`
 * → fill / disc, a stroke width → stroke / ring with flat caps and the
 * element's join. `null` for an unknown key.
 */
export function iofSymbolGlyph(key: string): Glyph | null {
  if (glyphCache.has(key)) return glyphCache.get(key)!;
  const svg = IOF_SYMBOLS[key];
  let glyph: Glyph | null = null;
  if (svg) {
    const parts: GlyphPart[] = [];
    for (const el of svg.match(/<(path|circle)\b[^>]*>/g) ?? []) {
      const filled = attr(el, "fill") === "black";
      const w = Number(attr(el, "stroke-width"));
      const stroked = attr(el, "stroke") === "black" && Number.isFinite(w) && w > 0;
      const join = attr(el, "stroke-linejoin") === "round" ? "round" : "miter";
      if (el.startsWith("<circle")) {
        const cx = Number(attr(el, "cx")) * PICTOGRAM_UNIT_UM;
        const cy = -Number(attr(el, "cy")) * PICTOGRAM_UNIT_UM;
        const r = Number(attr(el, "r")) * PICTOGRAM_UNIT_UM;
        if (filled) parts.push({ kind: "disc", colour: 0, diameterUm: 2 * r, cx, cy });
        if (stroked) parts.push({ kind: "ring", colour: 0, diameterUm: 2 * r + w * PICTOGRAM_UNIT_UM, widthUm: w * PICTOGRAM_UNIT_UM, cx, cy });
        continue;
      }
      const d = attr(el, "d");
      if (!d) continue;
      const geometry = pathGeometry(d);
      if (filled) parts.push({ kind: "fill", colour: 0, geometry: { ...geometry, closed: true } });
      if (stroked) parts.push({ kind: "stroke", colour: 0, widthUm: w * PICTOGRAM_UNIT_UM, cap: "flat", join, geometry });
    }
    if (parts.length) glyph = { parts, rotatable: false };
  }
  glyphCache.set(key, glyph);
  return glyph;
}

export interface DescriptionBlock {
  objects: RenderObject[];
  symbols: RenderSymbol[];
}

/**
 * The block's objects in page µm (y-up), with their symbols. `colourOf`
 * gives the stack index of a hex colour (the composer registers
 * `#ffffff` and the ink colour first).
 */
export function descriptionBlock(input: DescriptionBlockInput, paperHeightMm: number, colourOf: (hex: string) => number): DescriptionBlock {
  const { cellSizeMm: cell, rows } = input;
  const ink = colourOf(input.colour ?? "#000000");
  const paper = colourOf("#ffffff");
  const headerRows = input.header ? 3 : 1;
  const W = cell * 8;
  const Hb = cell * (rows.length + headerRows);
  const X = (mm: number) => Math.round((input.x + mm) * 1000);
  /** Block-relative y-down mm → page µm y-up. */
  const Y = (mm: number) => Math.round((paperHeightMm - input.y - mm) * 1000);

  const symbols: RenderSymbol[] = [];
  const objects: RenderObject[] = [];
  const known = new Map<string, number>();
  const symbol = (key: string, build: () => RenderSymbol): number => {
    let i = known.get(key);
    if (i === undefined) {
      i = symbols.length;
      symbols.push(build());
      known.set(key, i);
    }
    return i;
  };
  const lineSym = (mm: number) =>
    symbol(`line/${mm}`, () => parseRenderSymbol({ type: "line", id: `description:rule/${mm}`, code: "rule", name: "Description rule", main: { colour: ink, widthUm: Math.round(mm * 1000), cap: "flat", join: "miter" } }));
  const rule = (x1: number, y1: number, x2: number, y2: number, thick: boolean) =>
    objects.push({ symbolIdx: lineSym(thick ? THICK_MM : THIN_MM), path: makePath([X(x1), Y(y1), X(x2), Y(y2)]) });
  const text = (cx: number, baseline: number, sizeFactor: number, value: string, bold = false) => {
    if (!value) return;
    const sizeUm = Math.round(cell * sizeFactor * 1000);
    const idx = symbol(`text/${sizeUm}/${bold}`, () =>
      parseRenderSymbol({ type: "text", id: `description:text/${sizeUm}${bold ? "b" : ""}`, code: "text", name: "Description text", fontFamily: "liberation-sans", fontSizeUm: sizeUm, weight: bold ? 700 : 400, colour: ink, align: "centre" }),
    );
    objects.push({ symbolIdx: idx, path: makePath([X(cx), Y(baseline)]), text: value });
  };
  // Pictograms: 0.8 × cell for the −100…100 box (the legacy 10 % inset each side).
  const q = (0.8 * cell * 1000) / (200 * PICTOGRAM_UNIT_UM);
  const pictogram = (key: string | undefined | null, cx: number, cy: number) => {
    if (!key) return;
    const glyph = iofSymbolGlyph(key);
    if (!glyph) return;
    const idx = symbol(`iof/${key}`, () =>
      parseRenderSymbol({ type: "point", id: `iof:${key}`, code: key, name: `IOF ${key}`, orientation: "north", glyph: scaleGlyph({ ...glyph, parts: glyph.parts.map((p) => ({ ...p, colour: ink })) }, q) }),
    );
    objects.push({ symbolIdx: idx, path: makePath([X(cx), Y(cy)]) });
  };
  const cellContent = (c: DescriptionCell | null, column: number, top: number) => {
    if (!c) return;
    if (c.kind === "text") text(cell * column + cell / 2, top + cell * 0.67, 0.34, c.text);
    else pictogram(c.key, cell * column + cell / 2, top + cell / 2);
  };

  // Sheet: white, thick border.
  const box = [X(0), Y(0), X(W), Y(0), X(W), Y(Hb), X(0), Y(Hb)];
  const paperIdx = symbol("paper", () => parseRenderSymbol({ type: "area", id: "description:paper", code: "paper", name: "Description sheet", fill: paper }));
  objects.push({ symbolIdx: paperIdx, path: makePath(box, undefined, true) });
  objects.push({ symbolIdx: lineSym(THICK_MM), path: makePath(box, undefined, true) });

  if (input.header) {
    const h = input.header;
    rule(0, cell, W, cell, true);
    text(W / 2, cell * 0.68, 0.42, h.eventName, true);
    rule(0, cell * 2, W, cell * 2, true);
    text(W / 2, cell * 1.68, 0.4, h.classNames, true);
    rule(0, cell * 3, W, cell * 3, true);
    rule(cell * 3, cell * 2, cell * 3, cell * 3, true);
    rule(cell * 6, cell * 2, cell * 6, cell * 3, true);
    text(cell * 1.5, cell * 2.68, 0.4, h.courseName, true);
    text(cell * 4.5, cell * 2.68, 0.4, h.lengthKm, true);
    text(cell * 7, cell * 2.68, 0.4, h.climbM, true);
  } else {
    rule(0, cell, W, cell, true);
    text(W / 2, cell * 0.68, 0.48, input.title, true);
  }

  rows.forEach((row, i) => {
    const top = cell * (i + headerRows);
    const wide = row.kind === "special" || row.kind === "finish";
    if (!wide) {
      for (let column = 1; column < 8; column++) rule(cell * column, top, cell * column, top + cell, DESCRIPTION_THICK_COLUMNS.includes(column));
    }
    if (i < rows.length - 1) rule(0, top + cell, W, top + cell, hasThickRuleBelow(rows as DescriptionSheetRow[], i));
    if (wide) {
      pictogram(row.symbolKey, W / 2, top + cell / 2);
      if (row.lengthM != null && row.lengthM > 0) text(W / 2, top + cell * 0.67, 0.43 * 0.9, `${Math.round(row.lengthM)} m`, true);
      return;
    }
    if (row.kind === "start") pictogram("start", cell / 2, top + cell / 2);
    else {
      text(cell * 0.5, top + cell * 0.67, 0.43, row.sequence !== undefined ? String(row.sequence) : "");
      text(cell * 1.5, top + cell * 0.67, 0.43, row.code);
    }
    if (!row.description) return;
    const cells = descriptionCells(row.description);
    (["C", "D", "E", "F", "G", "H"] as const).forEach((k, n) => cellContent(cells[k], n + 2, top));
  });
  return { objects, symbols };
}

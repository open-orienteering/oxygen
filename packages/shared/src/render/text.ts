/**
 * Text shaping for map text: left-to-right Latin, advances + kerning
 * pairs from the font, alignment per line, digit-height sizing, tab
 * stops. Three layouts (map-rendering §4.9): block text from an anchor,
 * box text wrapped inside an object-level box (OCAD formatted text,
 * Mapper text boxes), and line text laid along its path. Output is glyph
 * ids and baseline origins in paper µm — what a `TextPass` carries.
 */

import type { PathMeasure } from "./measure.js";
import type { FontMetrics } from "./truetype.js";
import type { TextSymbol } from "./symbol.js";

export interface ShapedText {
  glyphs: number[];
  /** x, y per glyph, paper µm. */
  positions: number[];
  /** Em size actually used, µm. */
  sizeUm: number;
  /** Advance width of each line, µm. */
  lineWidths: number[];
  /** Rotation per glyph, degrees; absent when the text is upright. */
  angles?: number[];
  /**
   * The block's extent for a rectangle frame, in the text's own frame
   * (µm from the anchor, y-up, before rotation): `[x0, y0, x1, y1]`.
   * Absent for line text.
   */
  extent?: [number, number, number, number];
}

/** Em size for a symbol: digit height wins over the nominal em when given. */
export function emSizeUm(sym: Pick<TextSymbol, "fontSizeUm" | "digitHeightUm">, font: FontMetrics): number {
  if (sym.digitHeightUm) return (sym.digitHeightUm * font.unitsPerEm) / font.digitHeight;
  return sym.fontSizeUm;
}

export interface ShapeOptions {
  /** Anchor in paper µm: baseline origin of the first line for left/justify alignment; the anchor the text aligns to otherwise. For box text, the box's top-left corner. */
  x: number;
  y: number;
  /** Rotation about the anchor, degrees counter-clockwise. */
  angleDeg?: number;
  /** Box text: the box's size in its own frame; lines wrap at `widthUm` and the block sits in the box by `verticalAlign`. */
  box?: { widthUm: number; heightUm: number };
}

const SPACE = 0x20, TAB = 0x09;
/** Tab interval past the last stop, in space advances (provisional, S2). */
const DEFAULT_TAB_SPACES = 8;

interface LineMetrics {
  font: FontMetrics;
  sym: TextSymbol;
  k: number;
  charSpace: number;
  wordSpace: number;
  spaceGlyph: number;
}

interface LaidLine {
  cps: number[];
  ids: number[];
  /** Pen position of each code point, µm from the line start. */
  xs: number[];
  width: number;
}

function lineMetrics(sym: TextSymbol, font: FontMetrics, sizeUm: number): LineMetrics {
  const k = sizeUm / font.unitsPerEm;
  return { font, sym, k, charSpace: (sym.charSpacing ?? 0) * sizeUm, wordSpace: (sym.wordSpacing ?? 0) * sizeUm, spaceGlyph: font.glyphId(SPACE) };
}

/** The pen after a tab at `pen`: the first stop beyond it, else the next multiple of the default interval. */
function nextTab(pen: number, m: LineMetrics): number {
  for (const s of m.sym.tabStops ?? []) if (s.xUm > pen) return s.xUm;
  const step = DEFAULT_TAB_SPACES * m.font.advance(m.spaceGlyph) * m.k;
  return step > 0 ? (Math.floor(pen / step) + 1) * step : pen;
}

/** Pen positions along one line; `extraSpace` is added after every space (justification). */
function layLine(cps: number[], m: LineMetrics, extraSpace = 0): LaidLine {
  const ids = cps.map((cp) => m.font.glyphId(cp));
  const xs: number[] = [];
  let pen = 0;
  for (let i = 0; i < ids.length; i++) {
    if (cps[i] === TAB) {
      xs.push(pen);
      pen = nextTab(pen, m);
      continue;
    }
    if (i > 0 && cps[i - 1] !== TAB) pen += m.font.kerning(ids[i - 1], ids[i]) * m.k;
    xs.push(pen);
    pen += m.font.advance(ids[i]) * m.k + m.charSpace + (cps[i] === SPACE ? m.wordSpace + extraSpace : 0);
  }
  const last = cps[ids.length - 1];
  const width = !ids.length ? 0 : last === TAB ? pen : pen - m.charSpace - (last === SPACE ? m.wordSpace + extraSpace : 0);
  return { cps, ids, xs, width };
}

const isBreak = (cp: number) => cp === SPACE || cp === TAB;

/**
 * Greedy wrap of one paragraph at `widthUm`: a line ends before the
 * word whose ink would cross the width; a word wider than the box breaks
 * per glyph. Spaces at a wrap are dropped (trailing and leading).
 */
function wrapParagraph(cps: number[], widthUm: number, m: LineMetrics): number[][] {
  if (cps.length === 0) return [[]];
  const out: number[][] = [];
  let start = 0;
  while (start < cps.length) {
    const rest = cps.slice(start);
    const laid = layLine(rest, m);
    let end = rest.length;
    let lastBreak = -1;
    for (let i = 0; i < rest.length; i++) {
      if (isBreak(rest[i])) {
        lastBreak = i;
        continue;
      }
      const right = laid.xs[i] + m.font.advance(laid.ids[i]) * m.k;
      if (right > widthUm + 1e-6) {
        end = lastBreak > 0 ? lastBreak : Math.max(i, 1);
        break;
      }
    }
    let e = end;
    while (e > 0 && rest[e - 1] === SPACE) e--;
    out.push(rest.slice(0, e));
    start += end;
    if (start < cps.length) while (start < cps.length && cps[start] === SPACE) start++;
  }
  return out;
}

export function shapeText(text: string, sym: TextSymbol, font: FontMetrics, opts: ShapeOptions): ShapedText {
  const sizeUm = emSizeUm(sym, font);
  const m = lineMetrics(sym, font, sizeUm);
  const { k } = m;
  const lineAdvance = sizeUm * sym.lineSpacing;
  const box = opts.box;
  const paragraphs = text.split(/\r?\n/).map((p) => Array.from(p, (ch) => ch.codePointAt(0)!));

  // Lines with their baseline offset below the first baseline and whether they end a paragraph.
  const lines: { cps: number[]; down: number; lastOfParagraph: boolean }[] = [];
  let down = 0;
  paragraphs.forEach((p, pi) => {
    if (pi > 0) down += lineAdvance + (box ? sym.paragraphSpacingUm : 0);
    const wrapped = box ? wrapParagraph(p, box.widthUm, m) : [p];
    wrapped.forEach((cps, wi) => {
      if (wi > 0) down += lineAdvance;
      lines.push({ cps, down, lastOfParagraph: wi === wrapped.length - 1 });
    });
  });
  const lastBaseline = down;

  // Vertical anchor: how far the first baseline sits below the anchor.
  const ascent = font.ascender * k, descent = Math.abs(font.descender) * k;
  let drop: number;
  if (box) {
    // The anchor is the box's top edge; `baseline` reads as `top` (provisional, S2).
    const blockHeight = ascent + lastBaseline + descent;
    drop = sym.verticalAlign === "bottom" ? box.heightUm - blockHeight + ascent
      : sym.verticalAlign === "middle" ? (box.heightUm - blockHeight) / 2 + ascent
        : ascent;
  } else {
    drop = sym.verticalAlign === "top" ? ascent
      : sym.verticalAlign === "bottom" ? -(lastBaseline + descent)
        : sym.verticalAlign === "middle" ? (ascent - lastBaseline - descent) / 2
          : 0;
  }

  const glyphs: number[] = [];
  const positions: number[] = [];
  const lineWidths: number[] = [];
  const cos = Math.cos(((opts.angleDeg ?? 0) * Math.PI) / 180);
  const sin = Math.sin(((opts.angleDeg ?? 0) * Math.PI) / 180);
  const place = (lx: number, ly: number) => {
    positions.push(opts.x + lx * cos - ly * sin, opts.y + lx * sin + ly * cos);
  };

  let x0 = Infinity, x1 = -Infinity;
  for (const line of lines) {
    let laid = layLine(line.cps, m);
    if (box && sym.align === "justify" && !line.lastOfParagraph) {
      const spaces = line.cps.filter((cp) => cp === SPACE).length;
      if (spaces > 0 && laid.width < box.widthUm) laid = layLine(line.cps, m, (box.widthUm - laid.width) / spaces);
    }
    const { ids, xs, cps, width } = laid;
    lineWidths.push(width);
    const room = box ? box.widthUm : 0;
    const shift = sym.align === "centre" ? (room - width) / 2 : sym.align === "right" ? room - width : 0;
    x0 = Math.min(x0, shift);
    x1 = Math.max(x1, shift + width);
    // Paragraph spacing belongs to the box layout (formatted text), not to plain line breaks.
    const baseline = -line.down - drop;
    for (let i = 0; i < ids.length; i++) {
      if (cps[i] === TAB) continue; // tabs advance, never draw
      if (cps[i] === SPACE && ids[i] === m.spaceGlyph) continue; // spaces advance, never draw
      glyphs.push(ids[i]);
      place(xs[i] + shift, baseline);
    }
  }
  // Frame extent: the box width (box text) or the widest line, from the first line's digit height to the last baseline.
  const top = -drop + font.digitHeight * k;
  const bottom = -lastBaseline - drop;
  const extent: [number, number, number, number] = box ? [0, bottom, box.widthUm, top] : [x0, bottom, x1, top];
  const angle = opts.angleDeg ?? 0;
  return { glyphs, positions, sizeUm, lineWidths, extent, ...(angle !== 0 && glyphs.length ? { angles: glyphs.map(() => angle) } : {}) };
}

/**
 * Line text: one line laid along a path (OCAD line text). Each glyph's
 * origin sits on the path at its pen distance and the glyph turns to
 * the chord from there to the point one advance further (Purple Pen's
 * reading of OCAD). Text that does not fit is truncated, OCAD-style:
 * left and justify keep the glyph that crosses the end, right drops it,
 * centre keeps it but centres without it. `verticalAlign` moves the
 * baseline across the path (provisional, S2).
 */
export function shapeTextAlongPath(text: string, sym: TextSymbol, font: FontMetrics, measure: PathMeasure): ShapedText {
  const sizeUm = emSizeUm(sym, font);
  const m = lineMetrics(sym, font, sizeUm);
  const { k } = m;
  const L = measure.totalLength;
  const empty: ShapedText = { glyphs: [], positions: [], sizeUm, lineWidths: [0] };
  if (!(L > 0)) return empty;
  const cps = Array.from(text.replace(/\r?\n|\t/g, " "), (ch) => ch.codePointAt(0)!);
  const ids = cps.map((cp) => font.glyphId(cp));
  // Width of each glyph's cell: advance, spacing and the kerning to the next glyph.
  const widths: number[] = [];
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    const kern = i + 1 < ids.length ? font.kerning(ids[i], ids[i + 1]) * k : 0;
    const w = font.advance(ids[i]) * k + m.charSpace + (cps[i] === SPACE ? m.wordSpace : 0) + kern;
    widths.push(w);
    total += w;
    if (total + 10 >= L && sym.align !== "justify") break; // no room for more (10 µm: no sliver at the end)
  }
  let n = widths.length;
  if (L < total && (sym.align === "centre" || sym.align === "right")) {
    total -= widths[n - 1];
    if (sym.align === "right") n--;
  }
  const start = sym.align === "right" ? L - total : sym.align === "centre" ? (L - total) / 2 : 0;
  if (sym.align === "justify" && n > 1) {
    widths[n - 1] -= m.charSpace;
    total -= m.charSpace;
    const add = (L - total) / (n - 1);
    for (let i = 0; i < n - 1; i++) widths[i] += add;
  }
  // Baseline across the path: 0 on it, below it for top / middle, above it for bottom.
  const cap = font.digitHeight * k, descent = Math.abs(font.descender) * k;
  const across = sym.verticalAlign === "top" ? -cap : sym.verticalAlign === "middle" ? -cap / 2 : sym.verticalAlign === "bottom" ? descent : 0;

  const glyphs: number[] = [];
  const positions: number[] = [];
  const angles: number[] = [];
  let d = start;
  for (let i = 0; i < n; i++) {
    const a = measure.pointAt(Math.min(Math.max(d, 0), L));
    const b = measure.pointAt(Math.min(Math.max(d + widths[i], 0), L));
    d += widths[i];
    if (cps[i] === SPACE && ids[i] === m.spaceGlyph) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const [ux, uy] = len > 1e-9 ? [dx / len, dy / len] : [a.tx, a.ty];
    glyphs.push(ids[i]);
    positions.push(a.x - uy * across, a.y + ux * across);
    angles.push((Math.atan2(uy, ux) * 180) / Math.PI);
  }
  return { glyphs, positions, sizeUm, lineWidths: [total], ...(glyphs.length ? { angles } : {}) };
}

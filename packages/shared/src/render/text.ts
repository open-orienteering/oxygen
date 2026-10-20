/**
 * Text shaping for map text: left-to-right Latin, advances + kerning
 * pairs from the font, alignment per line, digit-height sizing. Output
 * is glyph ids and baseline origins in paper µm — what a `TextPass`
 * carries. Line breaking inside boxes (OCAD formatted text) is not part
 * of the pilot.
 */

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
}

/** Em size for a symbol: digit height wins over the nominal em when given. */
export function emSizeUm(sym: Pick<TextSymbol, "fontSizeUm" | "digitHeightUm">, font: FontMetrics): number {
  if (sym.digitHeightUm) return (sym.digitHeightUm * font.unitsPerEm) / font.digitHeight;
  return sym.fontSizeUm;
}

export interface ShapeOptions {
  /** Anchor in paper µm: baseline origin of the first line for left/justify alignment; the anchor the text aligns to otherwise. */
  x: number;
  y: number;
  /** Rotation about the anchor, degrees counter-clockwise. */
  angleDeg?: number;
}

export function shapeText(text: string, sym: TextSymbol, font: FontMetrics, opts: ShapeOptions): ShapedText {
  const sizeUm = emSizeUm(sym, font);
  const k = sizeUm / font.unitsPerEm;
  const charSpace = (sym.charSpacing ?? 0) * sizeUm;
  const wordSpace = (sym.wordSpacing ?? 0) * sizeUm;
  const lineAdvance = sizeUm * sym.lineSpacing;
  const lines = text.split(/\r?\n/);
  const glyphs: number[] = [];
  const positions: number[] = [];
  const lineWidths: number[] = [];
  const cos = Math.cos(((opts.angleDeg ?? 0) * Math.PI) / 180);
  const sin = Math.sin(((opts.angleDeg ?? 0) * Math.PI) / 180);
  const place = (lx: number, ly: number) => {
    positions.push(opts.x + lx * cos - ly * sin, opts.y + lx * sin + ly * cos);
  };

  lines.forEach((line, li) => {
    const cps = Array.from(line, (ch) => ch.codePointAt(0)!);
    const ids = cps.map((cp) => font.glyphId(cp));
    // Pen positions in font units × k.
    const xs: number[] = [];
    let pen = 0;
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) pen += font.kerning(ids[i - 1], ids[i]) * k;
      xs.push(pen);
      pen += font.advance(ids[i]) * k + charSpace + (cps[i] === 0x20 ? wordSpace : 0);
    }
    const width = ids.length ? pen - charSpace - (cps[ids.length - 1] === 0x20 ? wordSpace : 0) : 0;
    lineWidths.push(width);
    const shift = sym.align === "centre" ? -width / 2 : sym.align === "right" ? -width : 0;
    // Paragraph spacing belongs to the box layout (formatted text), not to plain line breaks.
    const baseline = -li * lineAdvance;
    for (let i = 0; i < ids.length; i++) {
      if (cps[i] === 0x20 && ids[i] === font.glyphId(0x20)) continue; // spaces advance, never draw
      glyphs.push(ids[i]);
      place(xs[i] + shift, baseline);
    }
  });
  return { glyphs, positions, sizeUm, lineWidths };
}

/**
 * OCAD symbol definitions → `RenderSymbol` IR (docs/map-import.md §3.3;
 * research record 03 Appendix C and §3.1). Stage 4 of the import.
 *
 * Input is the fork's symbol object, typed structurally; output is the
 * parsed IR (defaults applied) or `null` when the definition cannot be
 * expressed, plus coded warnings for the parts that were dropped or
 * approximated. Units: OCAD 1/100 mm → µm (×10); angles 0.1° → °;
 * colours by OCAD number → index in the document's colour stack.
 */

import { ocadFlags } from "../render/ocad-objects.js";
import {
  type DashPattern,
  type Glyph,
  type GlyphPart,
  type GlyphPlacement,
  type LineSymbolBody,
  type RenderSymbol,
  type RenderSymbolInput,
  type StrokeSpec,
  type TextSymbol,
  parseRenderSymbol,
} from "../render/symbol.js";
import type { OcadCoordinateLike, OcadSymbolLike } from "./ocad-source.js";

const UM = 10; // 1/100 mm → µm
const PT_UM = 352.7778; // 1 pt in µm

export interface OcadSymbolElementLike {
  /** 1 line, 2 area, 3 circle, 4 dot. */
  type: number;
  /** Line style for line elements (same coding as `lineStyle`). */
  flags?: number;
  color: number;
  /** 1/100 mm. */
  lineWidth?: number;
  /** 1/100 mm. */
  diameter?: number;
  coords: ArrayLike<OcadCoordinateLike>;
}

export interface OcadDoubleLineLike {
  dblMode?: number;
  dblFlags?: number;
  dblFillColor?: number;
  dblLeftColor?: number;
  dblRightColor?: number;
  dblWidth?: number;
  dblLeftWidth?: number;
  dblRightWidth?: number;
  dblLength?: number;
  dblGap?: number;
  dblBackgroundColor?: number;
}

/** Every field the four OCAD symbol types can carry, all optional; `type` selects. */
export interface OcadSymbolDefLike extends OcadSymbolLike {
  /** Bit 1: rotatable (point: object angle allowed; area: pattern / hatch follow the object angle). */
  flags?: number;
  // point / area
  elements?: ArrayLike<OcadSymbolElementLike>;
  // line
  lineColor?: number;
  lineWidth?: number;
  lineStyle?: number;
  distFromStart?: number;
  distToEnd?: number;
  mainLength?: number;
  endLength?: number;
  mainGap?: number;
  secGap?: number;
  endGap?: number;
  minSym?: number;
  nPrimSym?: number;
  primSymDist?: number;
  doubleLine?: OcadDoubleLineLike;
  decrease?: { decMode?: number };
  frColor?: number;
  frWidth?: number;
  frStyle?: number;
  useSymbolFlags?: number;
  primSymElements?: ArrayLike<OcadSymbolElementLike>;
  secSymElements?: ArrayLike<OcadSymbolElementLike>;
  cornerSymElements?: ArrayLike<OcadSymbolElementLike>;
  startSymElements?: ArrayLike<OcadSymbolElementLike>;
  endSymElements?: ArrayLike<OcadSymbolElementLike>;
  // area
  borderSym?: number;
  fillColor?: number;
  fillOn?: boolean;
  borderOn?: boolean;
  hatchMode?: number;
  hatchColor?: number;
  hatchLineWidth?: number;
  hatchDist?: number;
  hatchAngle1?: number;
  hatchAngle2?: number;
  structMode?: number;
  structDraw?: number;
  structWidth?: number;
  structHeight?: number;
  structAngle?: number;
  structIrregularVarX?: number;
  structIrregularVarY?: number;
  // text
  fontColor?: number;
  /** 1/10 pt. */
  fontSize?: number;
  weight?: number;
  italic?: boolean;
  charSpace?: number;
  wordSpace?: number;
  alignment?: number;
  lineSpace?: number;
  paraSpace?: number;
  lbOn?: boolean;
  frMode?: number;
  pointSymOn?: boolean;
}

export interface SymbolConversionContext {
  /** OCAD colour number → index in the document colour stack. */
  colourIndex: (ocadColour: number) => number | undefined;
  /** Symbol table lookup by `symNum` (for area border symbols). */
  symbolByNumber: (symNum: number) => OcadSymbolDefLike | undefined;
}

export interface SymbolConversionWarning {
  code:
    | "SYMBOL_COLOUR_UNKNOWN"
    | "SYMBOL_FEATURE_DROPPED"
    | "SYMBOL_TYPE_UNSUPPORTED"
    | "SYMBOL_EMPTY"
    | "FONT_SUBSTITUTED"
    | "IRREGULAR_PATTERN_REGULARISED";
  message: string;
}

export interface SymbolConversion {
  render: RenderSymbol | null;
  warnings: SymbolConversionWarning[];
}

/** OCAD line style → cap / join. Bit 2 is "pointed line ends"; the rest selects the join family. */
export function ocadLineStyle(style: number | undefined): { cap: StrokeSpec["cap"]; join: StrokeSpec["join"] } {
  const v = style ?? 0;
  const pointed = (v & 2) !== 0;
  const base = v & ~2;
  const join: StrokeSpec["join"] = base === 1 ? "round" : base === 4 ? "miter" : "bevel";
  const cap: StrokeSpec["cap"] = pointed ? "pointed" : base === 1 ? "round" : "flat";
  return { cap, join };
}

/** Metric-compatible names per shipped family; anything else is a substitution. */
const FONT_FAMILIES: [RegExp, TextSymbol["fontFamily"]][] = [
  [/^(arial narrow|liberation sans narrow)$/i, "liberation-sans-narrow"],
  [/^(arial|helvetica|liberation sans|arimo)$/i, "liberation-sans"],
  [/^(times new roman|times|liberation serif|tinos)$/i, "liberation-serif"],
  [/^(courier new|courier|liberation mono|cousine)$/i, "liberation-mono"],
];

/** Font name → shipped family; `substituted` when the name is not metric-compatible with the family. */
export function ocadFontFamily(name: string | undefined): { family: TextSymbol["fontFamily"]; substituted: boolean } {
  const n = (name ?? "").trim();
  for (const [re, family] of FONT_FAMILIES) if (re.test(n)) return { family, substituted: false };
  if (/narrow|condensed/i.test(n)) return { family: "liberation-sans-narrow", substituted: true };
  if (/mono|courier/i.test(n)) return { family: "liberation-mono", substituted: true };
  if (/serif|times|roman|garamond|book|georgia/i.test(n) && !/sans/i.test(n)) return { family: "liberation-serif", substituted: true };
  return { family: "liberation-sans", substituted: true };
}

class Converter {
  readonly warnings: SymbolConversionWarning[] = [];
  private readonly sym: OcadSymbolDefLike;
  private readonly ctx: SymbolConversionContext;
  constructor(sym: OcadSymbolDefLike, ctx: SymbolConversionContext) {
    this.sym = sym;
    this.ctx = ctx;
  }

  warn(code: SymbolConversionWarning["code"], message: string): void {
    this.warnings.push({ code, message });
  }

  /** Colour stack index for an OCAD colour number, warning once per missing number. */
  colour(ocadColour: number | undefined, what: string): number | undefined {
    if (ocadColour === undefined || ocadColour < 0) return undefined;
    const idx = this.ctx.colourIndex(ocadColour);
    if (idx === undefined) this.warn("SYMBOL_COLOUR_UNKNOWN", `${this.sym.number}: ${what} uses colour ${ocadColour}, which is not in the colour table`);
    return idx;
  }

  // ---- glyphs --------------------------------------------------------------

  glyph(elements: ArrayLike<OcadSymbolElementLike> | undefined, rotatable: boolean, what: string): Glyph | undefined {
    const parts: GlyphPart[] = [];
    for (let i = 0; i < (elements?.length ?? 0); i++) {
      const e = elements![i];
      const colour = this.colour(e.color, `${what} element ${i}`);
      if (colour === undefined) continue;
      const n = e.coords.length;
      const geometry = () => {
        const coords: number[] = [];
        const flags: number[] = [];
        for (let k = 0; k < n; k++) {
          const c = e.coords[k];
          coords.push(c[0] * UM, c[1] * UM);
          flags.push(ocadFlags(c.xFlags ?? 0, c.yFlags ?? 0));
        }
        return { coords, flags };
      };
      switch (e.type) {
        case 1: {
          if (n < 2) break;
          const { cap, join } = ocadLineStyle(e.flags);
          parts.push({ kind: "stroke", colour, widthUm: (e.lineWidth ?? 0) * UM, cap, join, geometry: geometry() });
          break;
        }
        case 2: {
          if (n < 3) break;
          parts.push({ kind: "fill", colour, geometry: { ...geometry(), closed: true } });
          break;
        }
        case 3: {
          const c = e.coords[0];
          parts.push({ kind: "ring", colour, diameterUm: (e.diameter ?? 0) * UM, widthUm: (e.lineWidth ?? 0) * UM, cx: (c?.[0] ?? 0) * UM, cy: (c?.[1] ?? 0) * UM });
          break;
        }
        case 4: {
          const c = e.coords[0];
          parts.push({ kind: "disc", colour, diameterUm: (e.diameter ?? 0) * UM, cx: (c?.[0] ?? 0) * UM, cy: (c?.[1] ?? 0) * UM });
          break;
        }
        default:
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.sym.number}: ${what} element type ${e.type}`);
      }
    }
    return parts.length ? { parts, rotatable } : undefined;
  }

  // ---- point ---------------------------------------------------------------

  point(): RenderSymbolInput | null {
    const s = this.sym;
    const rotatable = ((s.flags ?? 0) & 1) !== 0;
    const glyph = this.glyph(s.elements, rotatable, "point");
    if (!glyph) {
      this.warn("SYMBOL_EMPTY", `${s.number}: point symbol has no drawable element`);
      return null;
    }
    return { type: "point", ...this.common(), glyph, orientation: rotatable ? "object" : "north" };
  }

  // ---- line ----------------------------------------------------------------

  dash(): DashPattern | undefined {
    const s = this.sym;
    const main = s.mainLength ?? 0, gap = s.mainGap ?? 0, sec = s.secGap ?? 0, endGap = s.endGap ?? 0;
    if (main <= 0 || (gap <= 0 && sec <= 0 && endGap <= 0)) return undefined;
    const d: DashPattern = { layout: "ocad", dashUm: main * UM, gapUm: Math.max(0, gap) * UM };
    const end = s.endLength ?? 0;
    if (end > 0 && end !== main) d.endDashUm = end * UM;
    if (sec > 0) d.secondaryGapUm = sec * UM;
    if (endGap > 0) d.endGapUm = endGap * UM;
    const minSym = s.minSym ?? -1;
    if (minSym > 0) d.minGaps = minSym;
    return d;
  }

  lineBody(): LineSymbolBody | null {
    const s = this.sym;
    const body: LineSymbolBody = {};
    const { cap, join } = ocadLineStyle(s.lineStyle);
    const widthUm = (s.lineWidth ?? 0) * UM;
    const dash = this.dash();
    const frWidthUm = (s.frWidth ?? 0) * UM;

    // Main line. Kept (width 0) when a framing line or symbols need its dash layout.
    const lineColour = widthUm > 0 ? this.colour(s.lineColor, "main line") : undefined;
    if (lineColour !== undefined || frWidthUm > 0 || dash) {
      const main: StrokeSpec = { colour: lineColour ?? 0, widthUm: lineColour !== undefined ? widthUm : 0, cap, join };
      if (dash) main.dash = dash;
      if ((s.distFromStart ?? 0) > 0) main.shortenStartUm = s.distFromStart! * UM;
      if ((s.distToEnd ?? 0) > 0) main.shortenEndUm = s.distToEnd! * UM;
      // OCAD framing: a line of `frWidth` (total) drawn under the main line in its own colour.
      if (frWidthUm > 0) {
        const frColour = this.colour(s.frColor, "framing line");
        if (frColour !== undefined) {
          const per = (frWidthUm - main.widthUm) / 2;
          if (per > 0) main.halo = { colour: frColour, widthUm: per, continuous: true };
          else this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: framing line narrower than the main line`);
          if (main.widthUm === 0) Object.assign(main, ocadLineStyle(s.frStyle));
        }
      }
      body.main = main;
    }

    // Double line.
    const d = s.doubleLine;
    const mode = d?.dblMode ?? 0;
    if (d && mode >= 1 && mode <= 3) {
      const flags = d.dblFlags ?? 0;
      const w = (d.dblWidth ?? 0) * UM, lw = (d.dblLeftWidth ?? 0) * UM, rw = (d.dblRightWidth ?? 0) * UM;
      const borders: NonNullable<LineSymbolBody["borders"]> = {};
      const borderDash = (dashed: boolean): DashPattern | undefined =>
        dashed && (d.dblLength ?? 0) > 0 && (d.dblGap ?? 0) > 0 ? { layout: "ocad", dashUm: d.dblLength! * UM, gapUm: d.dblGap! * UM } : undefined;
      if (lw > 0) {
        const c = this.colour(d.dblLeftColor, "double line, left");
        if (c !== undefined) {
          borders.left = { colour: c, widthUm: lw, shiftUm: w / 2 + lw / 2 };
          const bd = borderDash(mode >= 2);
          if (bd) borders.left.dash = bd;
        }
      }
      if (rw > 0) {
        const c = this.colour(d.dblRightColor, "double line, right");
        if (c !== undefined) {
          borders.right = { colour: c, widthUm: rw, shiftUm: w / 2 + rw / 2 };
          const bd = borderDash(mode >= 3);
          if (bd) borders.right.dash = bd;
        }
      }
      if ((flags & 1) !== 0 && w > 0) {
        const c = this.colour(d.dblFillColor, "double line, fill");
        if (c !== undefined) {
          borders.backgroundColour = c;
          borders.backgroundWidthUm = w;
        }
      }
      if ((flags & 2) !== 0) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: double line background colour`);
      if (borders.left || borders.right || borders.backgroundColour !== undefined) body.borders = borders;
    } else if (mode !== 0) {
      this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: double line mode ${mode}`);
    }

    // Symbols along the line.
    const glyphs: NonNullable<LineSymbolBody["glyphs"]> = [];
    const add = (elements: ArrayLike<OcadSymbolElementLike> | undefined, placement: GlyphPlacement, what: string) => {
      const glyph = this.glyph(elements, true, what);
      if (glyph) glyphs.push({ glyph, placement });
    };
    const nPrim = s.nPrimSym ?? 0;
    if (nPrim > 0 && (s.primSymElements?.length ?? 0) > 0) {
      const main = s.mainLength ?? 0;
      if (dash && ((s.secGap ?? 0) > 0 || (s.endGap ?? 0) > 0)) {
        add(s.primSymElements, { at: "dashGroupCentres" }, "main symbol");
      } else if (dash) {
        add(s.primSymElements, { at: "dashCentres" }, "main symbol");
      } else if (main > 0) {
        const end = (s.endLength ?? 0) * UM;
        const minSym = s.minSym ?? -1;
        const placement: GlyphPlacement = { at: "spaced", distanceUm: main * UM, firstUm: end, lastUm: end };
        if (nPrim > 1) {
          placement.perSpot = nPrim;
          placement.spotSpacingUm = (s.primSymDist ?? 0) * UM;
        }
        if (minSym >= 0) placement.minCount = minSym + 1;
        add(s.primSymElements, placement, "main symbol");
      } else {
        this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: main symbol without a main length`);
      }
      if ((s.decrease?.decMode ?? 0) !== 0) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: decreasing symbol size`);
    }
    if ((s.secSymElements?.length ?? 0) > 0) add(s.secSymElements, { at: "sectionCentres" }, "secondary symbol");
    const use = s.useSymbolFlags ?? 0;
    if ((use & 4) !== 0) add(s.cornerSymElements, { at: "corners" }, "corner symbol");
    if ((use & 1) !== 0) add(s.startSymElements, { at: "start" }, "start symbol");
    if ((use & 2) !== 0) add(s.endSymElements, { at: "end" }, "end symbol");
    if (glyphs.length) body.glyphs = glyphs;

    if (!body.main && !body.borders && !body.glyphs) return null;
    return body;
  }

  line(): RenderSymbolInput | null {
    const body = this.lineBody();
    if (!body) {
      this.warn("SYMBOL_EMPTY", `${this.sym.number}: line symbol draws nothing`);
      return null;
    }
    return { type: "line", ...this.common(), ...body };
  }

  // ---- area ----------------------------------------------------------------

  area(): RenderSymbolInput | null {
    const s = this.sym;
    const out: RenderSymbolInput & { type: "area" } = { type: "area", ...this.common() };
    const rotatable = ((s.flags ?? 0) & 1) !== 0;
    const rotate = rotatable ? "manual" : "never";
    let drawn = false;
    if (s.fillOn) {
      const c = this.colour(s.fillColor, "fill");
      if (c !== undefined) {
        out.fill = c;
        drawn = true;
      }
    }
    const hatchMode = s.hatchMode ?? 0;
    if (hatchMode === 1 || hatchMode === 2) {
      const c = this.colour(s.hatchColor, "hatch");
      const widthUm = (s.hatchLineWidth ?? 0) * UM, spacingUm = (s.hatchDist ?? 0) * UM;
      if (c !== undefined && widthUm > 0 && spacingUm > 0) {
        out.hatches = [{ colour: c, widthUm, spacingUm, angleDeg: (s.hatchAngle1 ?? 0) / 10, rotate }];
        if (hatchMode === 2) out.hatches.push({ colour: c, widthUm, spacingUm, angleDeg: (s.hatchAngle2 ?? 0) / 10, rotate });
        drawn = true;
      } else if (c !== undefined) {
        this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: hatch with zero width or spacing`);
      }
    }
    const structMode = s.structMode ?? 0;
    if (structMode === 1 || structMode === 2) {
      const cellWidthUm = (s.structWidth ?? 0) * UM, cellHeightUm = (s.structHeight ?? 0) * UM;
      const glyph = this.glyph(s.elements, false, "pattern");
      if (glyph && cellWidthUm > 0 && cellHeightUm > 0) {
        const draw = s.structDraw ?? 0;
        out.patterns = [{
          glyph, cellWidthUm, cellHeightUm,
          angleDeg: (s.structAngle ?? 0) / 10,
          shiftedRows: structMode === 2,
          clip: draw === 1 ? "completelyInside" : draw === 2 ? "centreInside" : draw === 3 ? "partiallyInside" : "clip",
          rotate,
        }];
        drawn = true;
        if ((s.structIrregularVarX ?? 0) > 0 || (s.structIrregularVarY ?? 0) > 0) {
          this.warn("IRREGULAR_PATTERN_REGULARISED", `${s.number}: irregular pattern drawn as a regular grid`);
        }
      } else if (glyph) {
        this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: pattern with zero cell size`);
      }
    }
    if (s.borderOn && (s.borderSym ?? 0) > 0) {
      const b = this.ctx.symbolByNumber(s.borderSym!);
      if (b && b.type === 2) {
        const conv = new Converter(b, this.ctx);
        const body = conv.lineBody();
        this.warnings.push(...conv.warnings);
        if (body) {
          out.border = body;
          drawn = true;
        }
      } else {
        this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: border symbol ${s.borderSym} is not a line symbol in the table`);
      }
    }
    if (!drawn) {
      this.warn("SYMBOL_EMPTY", `${s.number}: area symbol draws nothing`);
      return null;
    }
    return out;
  }

  // ---- text ----------------------------------------------------------------

  text(): RenderSymbolInput | null {
    const s = this.sym;
    const colour = this.colour(s.fontColor, "text");
    if (colour === undefined) return null;
    const { family, substituted } = ocadFontFamily(s.fontName);
    if (substituted) this.warn("FONT_SUBSTITUTED", `${s.number}: font "${s.fontName ?? ""}" drawn with ${family}`);
    const fontSizeUm = Math.round(((s.fontSize ?? 100) / 10) * PT_UM);
    if (fontSizeUm <= 0) return null;
    const h = (s.alignment ?? 0) & 0x03;
    const v = (s.alignment ?? 0) & 0xfc;
    const out: RenderSymbolInput & { type: "text" } = {
      type: "text", ...this.common(),
      fontFamily: family,
      fontSizeUm,
      weight: s.weight ?? 400,
      italic: !!s.italic,
      colour,
      align: h === 1 ? "centre" : h === 2 ? "right" : h === 3 ? "justify" : "left",
      lineSpacing: (s.lineSpace ?? 100) > 0 ? (s.lineSpace ?? 100) / 100 : 1,
      paragraphSpacingUm: (s.paraSpace ?? 0) * UM,
      charSpacing: (s.charSpace ?? 0) / 100,
    };
    const ws = s.wordSpace ?? 100;
    // OCAD word spacing is a percentage of the normal space; approximate the normal space as 0.278 em.
    if (ws !== 100) out.wordSpacing = ((ws - 100) / 100) * 0.278;
    if (v !== 0) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: vertical text alignment ${v === 4 ? "middle" : v === 8 ? "top" : v}`);
    if ((s.frMode ?? 0) !== 0) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: text framing mode ${s.frMode}`);
    if (s.lbOn) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: line below text`);
    if (s.pointSymOn) this.warn("SYMBOL_FEATURE_DROPPED", `${s.number}: point symbol attached to text`);
    return out;
  }

  common(): { id: string; code: string; name: string } {
    return { id: `src:${this.sym.symNum}`, code: this.sym.number, name: this.sym.description ?? "" };
  }

  run(): SymbolConversion {
    let input: RenderSymbolInput | null;
    switch (this.sym.type) {
      case 1: input = this.point(); break;
      case 2: input = this.line(); break;
      case 3: input = this.area(); break;
      case 4: case 6: input = this.text(); break;
      default:
        this.warn("SYMBOL_TYPE_UNSUPPORTED", `${this.sym.number}: symbol type ${this.sym.type}`);
        input = null;
    }
    return { render: input ? parseRenderSymbol(input) : null, warnings: this.warnings };
  }
}

/** Convert one OCAD symbol definition. Never throws on data; unexpressible parts become warnings. */
export function ocadSymbolToRender(sym: OcadSymbolDefLike, ctx: SymbolConversionContext): SymbolConversion {
  return new Converter(sym, ctx).run();
}

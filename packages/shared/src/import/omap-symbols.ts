/**
 * OpenOrienteering Mapper symbol definitions → `RenderSymbol` IR
 * (docs/map-import.md §4.3; research record 03 Appendix C). Stage 4 of the
 * OMAP import.
 *
 * Units: Mapper's 0.001 mm *is* µm, so lengths pass through unchanged;
 * angles rad → °; y is negated (Mapper's y grows downward); colours by
 * priority → index in the document's colour stack. Combined symbols are
 * merged into one IR symbol (area with `border`, or line with
 * `borders.background` / `halo`) because the IR has no composition node —
 * the parts that cannot be merged are dropped with a coded warning.
 */

import { COORD_FLAG } from "../render/pass-stream.js";
import {
  type DashPattern,
  type Glyph,
  type GlyphPart,
  type GlyphPlacement,
  type LineSymbolBody,
  type RenderSymbolInput,
  type StrokeSpec,
  parseRenderSymbol,
} from "../render/symbol.js";
import { ocadFontFamily, type SymbolConversion, type SymbolConversionWarning } from "./ocad-symbols.js";
import {
  OMAP_FLAG,
  OMAP_SYMBOL_TYPE,
  type OmapAreaBody,
  type OmapCoord,
  type OmapLineBody,
  type OmapPointBody,
  type OmapSymbol,
  type OmapTextBody,
} from "./omap-reader.js";

export interface OmapSymbolConversionContext {
  /** Colour priority → index in the document colour stack. */
  colourIndex: (priority: number) => number | undefined;
  /** Symbol list lookup by `id` (combined-symbol part references). */
  symbolById: (id: number) => OmapSymbol | undefined;
}

/** How a Mapper `DashPoint` is mapped: as a dash-centre flag or as a corner. */
export type DashPointRule = "dash" | "corner";

/**
 * Mapper coordinate flags → `COORD_FLAG` bytes, following Mapper's own OCD
 * exporter: `CurveStart` on point *i* marks *i+1* / *i+2* as control points,
 * `HolePoint` on *i* marks *i+1* as the first point of a hole ring, a
 * `DashPoint` becomes a dash flag only on dashed lines without a dash
 * symbol (else a corner), `GapPoint` maps to the gap flag and `ClosePoint`
 * is dropped (the repeated closing coordinate is kept as geometry).
 */
export function omapFlags(coords: readonly OmapCoord[], dashRule: DashPointRule): number[] {
  const out = new Array<number>(coords.length).fill(0);
  for (let i = 0; i < coords.length; i++) {
    const f = coords[i].flags;
    if (f & OMAP_FLAG.curveStart) {
      if (i + 1 < coords.length) out[i + 1] |= COORD_FLAG.bezierFirst;
      if (i + 2 < coords.length) out[i + 2] |= COORD_FLAG.bezierSecond;
    }
    if (f & OMAP_FLAG.holePoint && i + 1 < coords.length) out[i + 1] |= COORD_FLAG.hole;
    if (f & OMAP_FLAG.dashPoint) out[i] |= dashRule === "dash" ? COORD_FLAG.dash : COORD_FLAG.corner;
    if (f & OMAP_FLAG.gapPoint) out[i] |= COORD_FLAG.gap;
  }
  return out;
}

/** Which flag a `DashPoint` gets for objects drawn with this line symbol (Mapper's exporter rule). */
export function dashPointRule(body: OmapLineBody | undefined): DashPointRule {
  if (!body) return "corner";
  return body.dashed && !body.dashSymbol ? "dash" : "corner";
}

const CAPS: StrokeSpec["cap"][] = ["flat", "round", "square", "pointed"];
const JOINS: StrokeSpec["join"][] = ["bevel", "miter", "round"];
const radToDeg = (r: number) => (r * 180) / Math.PI;

class Converter {
  readonly warnings: SymbolConversionWarning[] = [];
  private readonly sym: OmapSymbol;
  private readonly ctx: OmapSymbolConversionContext;
  /** Guard against reference cycles in combined symbols. */
  private readonly stack: Set<number>;

  constructor(sym: OmapSymbol, ctx: OmapSymbolConversionContext, stack: Set<number> = new Set()) {
    this.sym = sym;
    this.ctx = ctx;
    this.stack = stack;
  }

  private get label(): string {
    return this.sym.code || this.sym.name || `#${this.sym.id ?? "?"}`;
  }

  warn(code: SymbolConversionWarning["code"], message: string): void {
    this.warnings.push({ code, message });
  }

  colour(priority: number | undefined, what: string): number | undefined {
    if (priority === undefined || priority < 0) return undefined;
    const idx = this.ctx.colourIndex(priority);
    if (idx === undefined) this.warn("SYMBOL_COLOUR_UNKNOWN", `${this.label}: ${what} uses colour priority ${priority}, which is not in the colour table`);
    return idx;
  }

  // ---- glyphs --------------------------------------------------------------

  /** A point symbol (disc / ring / element objects) as a glyph; `rotatable` follows the point symbol, as in Mapper. */
  glyph(point: OmapSymbol | undefined, what: string): Glyph | undefined {
    const body = point?.body;
    if (!body || body.kind !== "point") return undefined;
    const parts: GlyphPart[] = [];
    this.glyphParts(body, 0, 0, what, parts, 0);
    return parts.length ? { parts, rotatable: body.rotatable } : undefined;
  }

  /** Parts of a point body translated by (`ox`, `oy`) in glyph-local µm (y already flipped). */
  private glyphParts(body: OmapPointBody, ox: number, oy: number, what: string, parts: GlyphPart[], depth: number): void {
    const centre = ox === 0 && oy === 0 ? {} : { cx: ox, cy: oy };
    if (body.innerRadius > 0) {
      const c = this.colour(body.innerColour, `${what} inner disc`);
      if (c !== undefined) parts.push({ kind: "disc", colour: c, diameterUm: body.innerRadius * 2, ...centre });
    }
    if (body.outerWidth > 0) {
      const c = this.colour(body.outerColour, `${what} outer ring`);
      if (c !== undefined) parts.push({ kind: "ring", colour: c, diameterUm: (body.innerRadius + body.outerWidth) * 2, widthUm: body.outerWidth, ...centre });
    }
    body.elements.forEach((el, i) => {
      const eb = el.symbol.body;
      const coords = el.object.coords;
      const geometry = (dashRule: DashPointRule) => {
        const xy: number[] = [];
        for (const c of coords) xy.push(c.x + ox, (c.y === 0 ? 0 : -c.y) + oy);
        return { coords: xy, flags: omapFlags(coords, dashRule) };
      };
      if (eb?.kind === "point") {
        // A nested point symbol placed at the element's coordinate (Mapper's double rings).
        if (depth > 4) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${what} element ${i} nested too deeply`);
          return;
        }
        const at = coords[0] ?? { x: 0, y: 0, flags: 0 };
        this.glyphParts(eb, ox + at.x, oy + (at.y === 0 ? 0 : -at.y), `${what} element ${i}`, parts, depth + 1);
      } else if (eb?.kind === "line") {
        if (coords.length < 2) return;
        const c = this.colour(eb.colour, `${what} element ${i}`);
        if (c === undefined) return;
        if (eb.dashed) this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${what} element ${i} dash pattern`);
        if (eb.borders) this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${what} element ${i} borders`);
        parts.push({ kind: "stroke", colour: c, widthUm: eb.lineWidth, cap: CAPS[eb.capStyle] ?? "flat", join: JOINS[eb.joinStyle] ?? "miter", geometry: geometry("corner") });
      } else if (eb?.kind === "area") {
        if (coords.length < 3) return;
        const c = this.colour(eb.innerColour, `${what} element ${i}`);
        if (eb.patterns.length) this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${what} element ${i} area pattern`);
        if (c === undefined) return;
        parts.push({ kind: "fill", colour: c, geometry: { ...geometry("corner"), closed: true } });
      } else {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${what} element ${i} of type ${el.symbol.type}`);
      }
    });
  }

  // ---- point ---------------------------------------------------------------

  point(): RenderSymbolInput | null {
    const body = this.sym.body as OmapPointBody;
    const glyph = this.glyph(this.sym, "point");
    if (!glyph) {
      this.warn("SYMBOL_EMPTY", `${this.label}: point symbol has no drawable element`);
      return null;
    }
    return { type: "point", ...this.common(), glyph, orientation: body.rotatable ? "object" : "north" };
  }

  // ---- line ----------------------------------------------------------------

  dash(b: OmapLineBody): DashPattern | undefined {
    if (!b.dashed || b.dashLength <= 0) return undefined;
    const d: DashPattern = { layout: "omap", dashUm: b.dashLength, gapUm: Math.max(0, b.breakLength) };
    if (b.dashesInGroup > 1) {
      d.dashesInGroup = b.dashesInGroup;
      d.secondaryGapUm = Math.max(0, b.inGroupBreakLength);
    }
    if (b.halfOuterDashes) d.halfOuterDashes = true;
    if (b.showAtLeastOneSymbol) d.showAtLeastOne = true;
    return d;
  }

  lineBody(b: OmapLineBody): LineSymbolBody | null {
    const body: LineSymbolBody = {};
    const cap = CAPS[b.capStyle] ?? "flat";
    const join = JOINS[b.joinStyle] ?? "miter";
    const dash = this.dash(b);
    const lineColour = b.lineWidth > 0 ? this.colour(b.colour, "main line") : undefined;
    const midGlyph = this.glyph(b.midSymbol, "mid symbol");

    if (lineColour !== undefined || (dash && midGlyph)) {
      const main: StrokeSpec = { colour: lineColour ?? 0, widthUm: lineColour !== undefined ? b.lineWidth : 0, cap, join };
      if (dash) main.dash = dash;
      if (cap === "pointed") {
        // Mapper draws the start/end offsets as the taper itself; the IR has
        // no taper length, so the pointed cap keeps the full line length.
      } else {
        if (b.startOffset > 0) main.shortenStartUm = b.startOffset;
        if (b.endOffset > 0) main.shortenEndUm = b.endOffset;
      }
      body.main = main;
    }

    if (b.borders) {
      const borders: NonNullable<LineSymbolBody["borders"]> = {};
      const conv = (side: "left" | "right") => {
        const bd = b.borders![side];
        if (bd.width <= 0 || bd.colour < 0 || (bd.dashed && bd.dashLength <= 0)) return;
        const c = this.colour(bd.colour, `${side} border`);
        if (c === undefined) return;
        const spec: NonNullable<typeof borders.left> = { colour: c, widthUm: bd.width, shiftUm: b.lineWidth / 2 + bd.shift };
        if (bd.dashed && bd.dashLength > 0) spec.dash = { layout: "omap", dashUm: bd.dashLength, gapUm: Math.max(0, bd.breakLength) };
        if (spec.shiftUm <= 0) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${side} border centred on the main line`);
          return;
        }
        borders[side] = spec;
      };
      conv("left");
      conv("right");
      if (borders.left || borders.right) body.borders = borders;
    }

    const glyphs: NonNullable<LineSymbolBody["glyphs"]> = [];
    if (midGlyph) {
      if (dash) {
        const at: GlyphPlacement["at"] = b.midSymbolPlacement === 2 ? "gapCentres" : b.midSymbolPlacement === 1 ? "dashGroupCentres" : "dashCentres";
        glyphs.push({ glyph: midGlyph, placement: { at } as GlyphPlacement });
      } else if (b.segmentLength > 0) {
        const placement: GlyphPlacement = { at: "spaced", distanceUm: b.segmentLength, firstUm: b.endLength, lastUm: b.endLength };
        if (b.midSymbolsPerSpot > 1) {
          placement.perSpot = b.midSymbolsPerSpot;
          placement.spotSpacingUm = Math.max(0, b.midSymbolDistance);
        }
        const minCount = Math.max(b.minimumMidSymbolCount, b.showAtLeastOneSymbol ? 1 : 0);
        if (minCount > 0) placement.minCount = minCount;
        if (b.minimumMidSymbolCountWhenClosed > 0) placement.minCountClosed = b.minimumMidSymbolCountWhenClosed;
        glyphs.push({ glyph: midGlyph, placement });
      } else {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: mid symbol without a segment length`);
      }
    }
    const dashGlyph = this.glyph(b.dashSymbol, "dash symbol");
    if (dashGlyph) {
      const entry: NonNullable<LineSymbolBody["glyphs"]>[number] = { glyph: dashGlyph, placement: { at: "corners", ignoreEnds: b.suppressDashSymbolAtEnds } };
      if (b.scaleDashSymbol) entry.scaleAtCorners = true;
      glyphs.push(entry);
    }
    const startGlyph = this.glyph(b.startSymbol, "start symbol");
    if (startGlyph) glyphs.push({ glyph: startGlyph, placement: { at: "start" } });
    const endGlyph = this.glyph(b.endSymbol, "end symbol");
    if (endGlyph) glyphs.push({ glyph: endGlyph, placement: { at: "end" } });
    if (glyphs.length) body.glyphs = glyphs;

    if (!body.main && !body.borders && !body.glyphs) return null;
    return body;
  }

  line(): RenderSymbolInput | null {
    const b = this.sym.body as OmapLineBody;
    const body = this.lineBody(b);
    if (!body) {
      this.warn("SYMBOL_EMPTY", `${this.label}: line symbol draws nothing`);
      return null;
    }
    const out: RenderSymbolInput & { type: "line" } = { type: "line", ...this.common(), ...body };
    if (b.minimumLength > 0) out.minimum = { lengthUm: b.minimumLength };
    return out;
  }

  // ---- area ----------------------------------------------------------------

  /** Fill / hatches / patterns of one area body, merged into `out`. */
  areaInto(b: OmapAreaBody, out: RenderSymbolInput & { type: "area" }): boolean {
    let drawn = false;
    if (b.innerColour >= 0) {
      const c = this.colour(b.innerColour, "fill");
      if (c !== undefined) {
        if (out.fill === undefined) {
          out.fill = c;
          drawn = true;
        } else if (out.fill !== c) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: second fill colour`);
        }
      }
    }
    b.patterns.forEach((p, i) => {
      const rotate = p.rotatable ? "manual" : "never";
      if (p.type === 1) {
        const c = this.colour(p.colour, `hatch ${i}`);
        if (c === undefined) return;
        if ((p.lineWidth ?? 0) <= 0 || p.lineSpacing <= 0) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: hatch ${i} with zero width or spacing`);
          return;
        }
        (out.hatches ??= []).push({ colour: c, widthUm: p.lineWidth!, spacingUm: p.lineSpacing, offsetUm: p.lineOffset, angleDeg: radToDeg(p.angle), rotate });
        drawn = true;
      } else if (p.type === 2) {
        const glyph = this.glyph(p.symbol, `pattern ${i}`);
        if (!glyph) {
          this.warn("SYMBOL_EMPTY", `${this.label}: pattern ${i} has no drawable point symbol`);
          return;
        }
        if ((p.pointDistance ?? 0) <= 0 || p.lineSpacing <= 0) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: pattern ${i} with zero cell size`);
          return;
        }
        (out.patterns ??= []).push({
          glyph,
          cellWidthUm: p.pointDistance!,
          cellHeightUm: p.lineSpacing,
          angleDeg: radToDeg(p.angle),
          offsetXUm: p.offsetAlongLine,
          offsetYUm: p.lineOffset,
          shiftedRows: false,
          clip: p.noClipping === 1 ? "completelyInside" : p.noClipping === 2 ? "centreInside" : p.noClipping === 3 ? "partiallyInside" : "clip",
          rotate,
        });
        drawn = true;
      } else {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: pattern ${i} of type ${p.type}`);
      }
    });
    return drawn;
  }

  area(): RenderSymbolInput | null {
    const b = this.sym.body as OmapAreaBody;
    const out: RenderSymbolInput & { type: "area" } = { type: "area", ...this.common() };
    if (!this.areaInto(b, out)) {
      this.warn("SYMBOL_EMPTY", `${this.label}: area symbol draws nothing`);
      return null;
    }
    if (b.minArea > 0) out.minimum = { areaUm2: b.minArea };
    return out;
  }

  // ---- text ----------------------------------------------------------------

  text(): RenderSymbolInput | null {
    const b = this.sym.body as OmapTextBody;
    const colour = this.colour(b.colour, "text");
    if (colour === undefined) return null;
    const { family, substituted } = ocadFontFamily(b.fontFamily);
    if (substituted) this.warn("FONT_SUBSTITUTED", `${this.label}: font "${b.fontFamily}" drawn with ${family}`);
    if (b.fontSize <= 0) {
      this.warn("SYMBOL_EMPTY", `${this.label}: text symbol with zero font size`);
      return null;
    }
    const out: RenderSymbolInput & { type: "text" } = {
      type: "text", ...this.common(),
      fontFamily: family,
      fontSizeUm: b.fontSize,
      weight: b.bold ? 700 : 400,
      italic: b.italic,
      colour,
      align: "left",
      lineSpacing: b.lineSpacing > 0 ? b.lineSpacing : 1,
      paragraphSpacingUm: Math.max(0, b.paragraphSpacing),
      charSpacing: b.characterSpacing,
    };
    if (b.framing && b.framing.colour >= 0) {
      if (b.framing.mode === 1 && b.framing.lineHalfWidth > 0) {
        const c = this.colour(b.framing.colour, "text framing");
        if (c !== undefined) out.halo = { colour: c, widthUm: b.framing.lineHalfWidth };
      } else if (b.framing.mode !== 0) {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: text framing mode ${b.framing.mode}`);
      }
    }
    if (b.underline) this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: underline`);
    if (b.lineBelow && b.lineBelow.colour >= 0 && b.lineBelow.width > 0) this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: line below text`);
    return out;
  }

  // ---- combined ------------------------------------------------------------

  /** Flatten the parts of a combined symbol (nested combinations included). */
  private parts(sym: OmapSymbol, depth = 0): OmapSymbol[] {
    const body = sym.body;
    if (!body || body.kind !== "combined") return [sym];
    if (depth > 4) {
      this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: combined symbol nested too deeply`);
      return [];
    }
    const out: OmapSymbol[] = [];
    for (const p of body.parts) {
      if (p === null) continue;
      let part: OmapSymbol | undefined;
      if ("ref" in p) {
        if (this.stack.has(p.ref)) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: combined symbol references itself`);
          continue;
        }
        part = this.ctx.symbolById(p.ref);
        if (!part) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: combined part references missing symbol ${p.ref}`);
          continue;
        }
        this.stack.add(p.ref);
        out.push(...this.parts(part, depth + 1));
        this.stack.delete(p.ref);
      } else {
        out.push(...this.parts(p.symbol, depth + 1));
      }
    }
    return out;
  }

  /** Merge several line bodies into one (03 Appendix C: borders + background band, halo, glyphs). */
  mergeLines(bodies: LineSymbolBody[]): LineSymbolBody | null {
    const live = bodies;
    if (!live.length) return null;
    const widthOf = (b: LineSymbolBody) => (b.main && b.main.widthUm > 0 ? b.main.widthUm : Infinity);
    let primary = live.find((b) => b.main?.dash && b.main.widthUm > 0) ?? live.find((b) => b.main?.dash);
    if (!primary) {
      primary = live.reduce((best, b) => (widthOf(b) < widthOf(best) ? b : best), live[0]);
    }
    const result: LineSymbolBody = structuredClone(primary);
    for (const part of live) {
      if (part === primary) continue;
      let bordersConsumed = false;
      const m = part.main;
      if (m && m.widthUm > 0) {
        if (m.dash) {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: second dashed line in combined symbol`);
        } else if (!result.main) {
          result.main = structuredClone(m);
        } else if (part.borders && !result.borders) {
          result.borders = { ...structuredClone(part.borders), backgroundColour: m.colour, backgroundWidthUm: m.widthUm };
          bordersConsumed = true;
        } else if (m.widthUm > result.main.widthUm && !result.main.halo) {
          result.main.halo = { colour: m.colour, widthUm: (m.widthUm - result.main.widthUm) / 2, continuous: true };
        } else if (result.borders && result.borders.backgroundColour === undefined) {
          result.borders.backgroundColour = m.colour;
          result.borders.backgroundWidthUm = m.widthUm;
        } else {
          this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: extra main line (${m.widthUm} µm) in combined symbol`);
        }
      }
      if (part.borders && !bordersConsumed) {
        if (!result.borders) result.borders = structuredClone(part.borders);
        else this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: extra border pair in combined symbol`);
      }
      if (part.glyphs?.length) (result.glyphs ??= []).push(...structuredClone(part.glyphs));
    }
    return result;
  }

  combined(): RenderSymbolInput | null {
    const parts = this.parts(this.sym);
    const areas = parts.filter((p) => p.body?.kind === "area");
    const lines = parts.filter((p) => p.body?.kind === "line");
    for (const p of parts) {
      if (p.body?.kind === "point" || p.body?.kind === "text") {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: ${p.body.kind} part of combined symbol`);
      } else if (!p.body) {
        this.warn("SYMBOL_FEATURE_DROPPED", `${this.label}: part without a definition`);
      }
    }
    const lineBodies = lines.map((l) => this.lineBody(l.body as OmapLineBody)).filter((b): b is LineSymbolBody => !!b);
    if (areas.length) {
      const out: RenderSymbolInput & { type: "area" } = { type: "area", ...this.common() };
      let drawn = false;
      for (const a of areas) drawn = this.areaInto(a.body as OmapAreaBody, out) || drawn;
      const border = this.mergeLines(lineBodies);
      if (border) {
        out.border = border;
        drawn = true;
      }
      if (!drawn) {
        this.warn("SYMBOL_EMPTY", `${this.label}: combined symbol draws nothing`);
        return null;
      }
      return out;
    }
    const body = this.mergeLines(lineBodies);
    if (!body) {
      this.warn("SYMBOL_EMPTY", `${this.label}: combined symbol draws nothing`);
      return null;
    }
    return { type: "line", ...this.common(), ...body };
  }

  common(): { id: string; code: string; name: string } {
    return { id: `src:${this.sym.id ?? this.sym.code}`, code: this.sym.code, name: this.sym.name };
  }

  run(): SymbolConversion {
    let input: RenderSymbolInput | null;
    const kind = this.sym.body?.kind;
    switch (kind) {
      case "point": input = this.point(); break;
      case "line": input = this.line(); break;
      case "area": input = this.area(); break;
      case "text": input = this.text(); break;
      case "combined": input = this.combined(); break;
      default:
        this.warn("SYMBOL_TYPE_UNSUPPORTED", `${this.label}: symbol type ${this.sym.type}`);
        input = null;
    }
    return { render: input ? parseRenderSymbol(input) : null, warnings: this.warnings };
  }
}

/** Convert one Mapper symbol definition. Never throws on data; unexpressible parts become warnings. */
export function omapSymbolToRender(sym: OmapSymbol, ctx: OmapSymbolConversionContext): SymbolConversion {
  return new Converter(sym, ctx, sym.id !== undefined ? new Set([sym.id]) : new Set()).run();
}

/**
 * The IR kind objects of this symbol produce (`area` when any part is an
 * area, `line` for line-only combinations). Used by the normaliser to pick
 * the object type and the dash-point rule.
 */
export function omapSymbolKind(sym: OmapSymbol, symbolById: (id: number) => OmapSymbol | undefined, depth = 0): "point" | "line" | "area" | "text" | undefined {
  const body = sym.body;
  if (!body) return undefined;
  if (body.kind !== "combined") return body.kind;
  if (depth > 4) return undefined;
  let kind: "line" | "area" | undefined;
  for (const p of body.parts) {
    if (p === null) continue;
    const part = "ref" in p ? symbolById(p.ref) : p.symbol;
    if (!part) continue;
    const k = omapSymbolKind(part, symbolById, depth + 1);
    if (k === "area") return "area";
    if (k === "line") kind = "line";
  }
  return kind;
}

/**
 * The line body that governs an object's dash points: the symbol itself, or
 * for combined symbols the first dashed line part (else the first line part).
 */
export function omapGoverningLine(sym: OmapSymbol, symbolById: (id: number) => OmapSymbol | undefined, depth = 0): OmapLineBody | undefined {
  const body = sym.body;
  if (!body) return undefined;
  if (body.kind === "line") return body;
  if (body.kind !== "combined" || depth > 4) return undefined;
  let first: OmapLineBody | undefined;
  for (const p of body.parts) {
    if (p === null) continue;
    const part = "ref" in p ? symbolById(p.ref) : p.symbol;
    if (!part) continue;
    const l = omapGoverningLine(part, symbolById, depth + 1);
    if (!l) continue;
    if (l.dashed) return l;
    first ??= l;
  }
  return first;
}

export { OMAP_SYMBOL_TYPE };

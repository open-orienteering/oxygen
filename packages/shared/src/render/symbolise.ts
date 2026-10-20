/**
 * The symbolisation stage: objects + `RenderSymbol` IR → `PassStream`.
 * Pure, deterministic, no DOM. Everything a ruler could measure on paper
 * is decided here (04 §4.1); nothing here depends on pixels.
 *
 * Normative description of each rule: docs/map-rendering.md §4.
 */

import {
  COORD_FLAG,
  type FontRef,
  type Pass,
  type PassStream,
  PassStreamBuilder,
  type RenderPath,
  type Slice,
  makePath,
} from "./pass-stream.js";
import { type Interval, layoutDashes } from "./dash.js";
import { flattenRings, offsetPolyline } from "./geometry.js";
import { GlyphRegistry, type RegisteredGlyph, mapCap, mapJoin } from "./glyph-table.js";
import { PathMeasure, gapIntervals, pathSections, subtractIntervals, wrapIntervals } from "./measure.js";
import { patternInstances } from "./pattern.js";
import { placeGlyphs } from "./placement.js";
import type { AreaSymbol, BorderSpec, LineSymbolBody, PointSymbol, RenderSymbol, StrokeSpec, TextSymbol } from "./symbol.js";
import { shapeText } from "./text.js";
import type { FontMetrics } from "./truetype.js";

export interface RenderObject {
  symbolIdx: number;
  /** Geometry; point and text objects carry a single point. */
  path: RenderPath;
  /** OCAD `ang`: point rotation, area pattern angle, text angle. Degrees. */
  angleDeg?: number;
  text?: string;
}

export interface SymboliseInput {
  objects: RenderObject[];
  symbols: RenderSymbol[];
  /** Available fonts; a text symbol resolves to the first font of its family. */
  fonts: FontMetrics[];
}

export interface SymboliseWarning {
  objectIdx: number;
  code: "UNKNOWN_SYMBOL" | "NO_FONT" | "EMPTY_GEOMETRY" | "TEXT_WITHOUT_TEXT";
  message: string;
}

export interface SymboliseResult {
  stream: PassStream;
  warnings: SymboliseWarning[];
}

const toRad = (d: number) => (d * Math.PI) / 180;

class Stage {
  readonly builder = new PassStreamBuilder();
  readonly glyphs = new GlyphRegistry();
  readonly warnings: SymboliseWarning[] = [];
  private objectIdx = 0;
  private symbolIdx = 0;
  private readonly input: SymboliseInput;

  constructor(input: SymboliseInput) {
    this.input = input;
    input.fonts.forEach((f, i) => {
      this.builder.fontTable.push({ fontId: i, family: f.family, bold: !!f.bold, italic: !!f.italic } satisfies FontRef);
    });
  }

  run(): SymboliseResult {
    this.input.objects.forEach((obj, i) => {
      this.objectIdx = i;
      this.symbolIdx = obj.symbolIdx;
      const sym = this.input.symbols[obj.symbolIdx];
      if (!sym) {
        this.warn("UNKNOWN_SYMBOL", `object ${i} references symbol ${obj.symbolIdx}`);
        return;
      }
      if (obj.path.coords.length === 0) {
        this.warn("EMPTY_GEOMETRY", `object ${i} has no coordinates`);
        return;
      }
      switch (sym.type) {
        case "point":
          this.point(obj, sym);
          break;
        case "line":
          this.line(obj.path, sym);
          break;
        case "area":
          this.area(obj, sym);
          break;
        case "text":
          this.text(obj, sym);
          break;
      }
    });
    this.builder.glyphTable.push(...this.glyphs.table);
    return { stream: this.builder.build(), warnings: this.warnings };
  }

  private warn(code: SymboliseWarning["code"], message: string): void {
    this.warnings.push({ objectIdx: this.objectIdx, code, message });
  }

  private push(pass: Pass): void {
    this.builder.push(pass, this.objectIdx, this.symbolIdx);
  }

  // ---- glyph instances ---------------------------------------------------

  private glyphPasses(reg: RegisteredGlyph, inst: { x: number; y: number; angleDeg: number; scale?: number }[], clip?: RenderPath): void {
    if (inst.length === 0) return;
    const data = new Float32Array(inst.length * 5);
    inst.forEach((p, i) => {
      const r = toRad(p.angleDeg);
      data[5 * i] = p.x;
      data[5 * i + 1] = p.y;
      data[5 * i + 2] = Math.cos(r);
      data[5 * i + 3] = Math.sin(r);
      data[5 * i + 4] = p.scale ?? 1;
    });
    reg.meshes.forEach((mesh, partIdx) => {
      this.push({
        kind: "glyph",
        colour: reg.colours[partIdx],
        glyphId: reg.glyphId,
        partIdx,
        instances: data,
        ...(clip ? { clip } : {}),
      });
    });
  }

  // ---- point -------------------------------------------------------------

  private point(obj: RenderObject, sym: PointSymbol): void {
    const reg = this.glyphs.register(sym.glyph);
    const angle = sym.orientation === "object" && sym.glyph.rotatable ? (obj.angleDeg ?? 0) : 0;
    this.glyphPasses(reg, [{ x: obj.path.coords[0], y: obj.path.coords[1], angleDeg: angle }]);
  }

  // ---- line --------------------------------------------------------------

  private line(path: RenderPath, sym: LineSymbolBody): void {
    if (path.coords.length < 4) return;
    const m = new PathMeasure(path);
    if (m.totalLength <= 0) return;
    const gaps = gapIntervals(m);

    let mainIntervals: Interval[] | undefined;
    if (sym.main) {
      mainIntervals = this.strokeIntervals(m, sym.main);
      if (gaps.length) mainIntervals = subtractIntervals(mainIntervals ?? [[0, m.totalLength]], gaps);
      const slices = mainIntervals ? toSlices(m, mainIntervals) : undefined;
      const taper = strokeTaper(sym.main);
      const haloWidth = sym.main.halo ? sym.main.widthUm + 2 * sym.main.halo.widthUm : 0;
      if (sym.main.halo && haloWidth > 0) {
        const haloSlices = sym.main.halo.continuous ? (gaps.length ? toSlices(m, subtractIntervals([[0, m.totalLength]], gaps)) : undefined) : slices;
        this.push({
          kind: "stroke",
          colour: sym.main.halo.colour,
          path,
          ...(haloSlices ? { slices: haloSlices } : {}),
          widthUm: haloWidth,
          cap: mapCap(sym.main.cap),
          join: mapJoin(sym.main.join),
          ...(taper ? { taper } : {}),
        });
      }
      if (sym.main.widthUm > 0) {
        this.push({
          kind: "stroke",
          colour: sym.main.colour,
          path,
          ...(slices ? { slices } : {}),
          widthUm: sym.main.widthUm,
          cap: mapCap(sym.main.cap),
          join: mapJoin(sym.main.join),
          ...(taper ? { taper } : {}),
        });
      }
    }

    if (sym.borders) {
      const flat = flattenRings(path, 5)[0] ?? [];
      const { left, right, backgroundColour, backgroundWidthUm } = sym.borders;
      const width = backgroundWidthUm ?? (left && right ? left.shiftUm + right.shiftUm : undefined);
      if (backgroundColour !== undefined && width !== undefined) {
        const centre = left && right ? (left.shiftUm - right.shiftUm) / 2 : 0;
        const bgPath = centre === 0 ? path : polyPath(offsetPolyline(flat, centre, path.closed), path.closed);
        this.push({ kind: "stroke", colour: backgroundColour, path: bgPath, widthUm: width, cap: "butt", join: "miter" });
      }
      if (left) this.border(m, flat, left, +1, COORD_FLAG.noLeft, sym.main);
      if (right) this.border(m, flat, right, -1, COORD_FLAG.noRight, sym.main);
    }

    for (const g of sym.glyphs ?? []) {
      const reg = this.glyphs.register(g.glyph);
      const placements = placeGlyphs(m, g.placement, {
        dash: sym.main?.dash,
        scaleAtCorners: g.scaleAtCorners,
        rotatable: g.glyph.rotatable,
      });
      this.glyphPasses(
        reg,
        placements.map((p) => {
          const pt = m.pointAt(p.len);
          return { x: pt.x, y: pt.y, angleDeg: p.angleDeg, scale: p.scale };
        }),
      );
    }
  }

  /** Drawn length intervals of a stroke, or undefined when the whole path is drawn. */
  private strokeIntervals(m: PathMeasure, spec: StrokeSpec): Interval[] | undefined {
    const shortenS = spec.shortenStartUm ?? 0, shortenE = spec.shortenEndUm ?? 0;
    if (!spec.dash && shortenS === 0 && shortenE === 0) return undefined;
    const sections = pathSections(m);
    const out: Interval[] = [];
    sections.forEach((sec, i) => {
      let a = sec.startLen, b = sec.endLen;
      if (i === 0 && !m.path.closed) a += shortenS;
      if (i === sections.length - 1 && !m.path.closed) b -= shortenE;
      if (b <= a) return;
      if (!spec.dash) {
        out.push([a, b]);
        return;
      }
      const opts = { closedLoop: sec.closedLoop, halfStart: sec.dashStart, halfEnd: sec.dashEnd };
      for (const [d0, d1] of layoutDashes(b - a, spec.dash, opts)) out.push([a + d0, a + d1]);
    });
    return wrapIntervals(out, m.totalLength);
  }

  private border(m: PathMeasure, flat: number[], spec: BorderSpec, side: 1 | -1, noFlag: number, main: StrokeSpec | undefined): void {
    const offset = offsetPolyline(flat, side * spec.shiftUm, m.path.closed);
    const bPath = polyPath(offset, m.path.closed);
    const bm = new PathMeasure(bPath);
    if (bm.totalLength <= 0) return;
    const ratio = bm.totalLength / m.totalLength;
    // Dashes are laid out on the main line and transferred proportionally,
    // so both borders and a dashed main line share phase (03 §6.9 item 6).
    let intervals: Interval[] | undefined;
    if (spec.dash) {
      const onMain: Interval[] = [];
      for (const sec of pathSections(m)) {
        const opts = { closedLoop: sec.closedLoop, halfStart: sec.dashStart, halfEnd: sec.dashEnd };
        for (const [a, b] of layoutDashes(sec.endLen - sec.startLen, spec.dash, opts)) onMain.push([sec.startLen + a, sec.startLen + b]);
      }
      intervals = wrapIntervals(onMain, m.totalLength).map(([a, b]): Interval => [a * ratio, b * ratio]);
    }
    // `noLeft` / `noRight` points suppress the border up to the next point.
    const holes: Interval[] = [];
    const f = m.path.flags;
    const ptLen = pointLengths(m);
    for (let p = 0; p < f.length - 1; p++) {
      if (f[p] & noFlag) holes.push([ptLen[p] * ratio, ptLen[p + 1] * ratio]);
    }
    if (holes.length) intervals = subtractIntervals(intervals ?? [[0, bm.totalLength]], holes);
    const slices = intervals ? toSlices(bm, intervals) : undefined;
    this.push({
      kind: "stroke",
      colour: spec.colour,
      path: bPath,
      ...(slices ? { slices } : {}),
      widthUm: spec.widthUm,
      cap: main ? mapCap(main.cap) : "butt",
      join: main ? mapJoin(main.join) : "miter",
    });
  }

  // ---- area --------------------------------------------------------------

  private area(obj: RenderObject, sym: AreaSymbol): void {
    const path: RenderPath = obj.path.closed ? obj.path : { ...obj.path, closed: true };
    if (sym.fill !== undefined) this.push({ kind: "fill", colour: sym.fill, path, rule: "evenodd" });
    for (const h of sym.hatches ?? []) {
      const angle = h.rotate === "never" ? h.angleDeg : h.angleDeg + (obj.angleDeg ?? 0);
      this.push({ kind: "hatch", colour: h.colour, path, widthUm: h.widthUm, spacingUm: h.spacingUm, offsetUm: h.offsetUm, angleDeg: angle });
    }
    for (const p of sym.patterns ?? []) {
      const reg = this.glyphs.register(p.glyph);
      const { instances, clip } = patternInstances(path, p, { objectAngleDeg: obj.angleDeg, extent: reg.extent });
      this.glyphPasses(reg, instances, clip ? path : undefined);
    }
    if (sym.border) this.line(path, sym.border);
  }

  // ---- text --------------------------------------------------------------

  private text(obj: RenderObject, sym: TextSymbol): void {
    if (obj.text === undefined || obj.text.length === 0) {
      this.warn("TEXT_WITHOUT_TEXT", `object ${this.objectIdx} has a text symbol but no text`);
      return;
    }
    const fontId = resolveFont(this.input.fonts, sym);
    if (fontId < 0) {
      this.warn("NO_FONT", `no font for family ${sym.fontFamily}`);
      return;
    }
    const font = this.input.fonts[fontId];
    const shaped = shapeText(obj.text, sym, font, { x: obj.path.coords[0], y: obj.path.coords[1], angleDeg: obj.angleDeg });
    if (shaped.glyphs.length === 0) return;
    const glyphs = Uint16Array.from(shaped.glyphs);
    const positions = Float32Array.from(shaped.positions);
    const angles = shaped.angles ? { angles: Float32Array.from(shaped.angles) } : {};
    if (sym.shadow) {
      // The offset is in the text's own frame, so it turns with the text.
      const r = toRad(obj.angleDeg ?? 0);
      const dx = sym.shadow.offsetXUm * Math.cos(r) - sym.shadow.offsetYUm * Math.sin(r);
      const dy = sym.shadow.offsetXUm * Math.sin(r) + sym.shadow.offsetYUm * Math.cos(r);
      const shifted = Float32Array.from(shaped.positions, (v, i) => v + (i % 2 === 0 ? dx : dy));
      this.push({ kind: "text", colour: sym.shadow.colour, fontId, sizeUm: shaped.sizeUm, glyphs, positions: shifted, ...angles });
    }
    if (sym.halo) {
      this.push({ kind: "text", colour: sym.halo.colour, fontId, sizeUm: shaped.sizeUm, glyphs, positions, ...angles, haloWidthUm: sym.halo.widthUm });
    }
    this.push({ kind: "text", colour: sym.colour, fontId, sizeUm: shaped.sizeUm, glyphs, positions, ...angles });
  }
}

/** The pass's taper: only on a pointed stroke whose IR gives taper lengths (map-rendering §3.2). */
function strokeTaper(spec: StrokeSpec): { startUm?: number; endUm?: number } | undefined {
  if (spec.cap !== "pointed" || !spec.taper) return undefined;
  const { startUm, endUm } = spec.taper;
  if (!startUm && !endUm) return undefined;
  return { ...(startUm ? { startUm } : {}), ...(endUm ? { endUm } : {}) };
}

/**
 * The font for a text symbol: the first loaded face of its family whose
 * bold / italic match (`weight ≥ 600` is bold), else the family's first
 * face. −1 when the family is not loaded at all.
 */
function resolveFont(fonts: FontMetrics[], sym: TextSymbol): number {
  const bold = sym.weight >= 600;
  const exact = fonts.findIndex((f) => f.family === sym.fontFamily && !!f.bold === bold && !!f.italic === sym.italic);
  return exact >= 0 ? exact : fonts.findIndex((f) => f.family === sym.fontFamily);
}

function toSlices(m: PathMeasure, intervals: Interval[]): Slice[] {
  return intervals.filter(([a, b]) => b > a).map(([a, b]) => m.sliceBetween(a, b));
}

function polyPath(pts: number[], closed: boolean): RenderPath {
  return makePath(pts.map(Math.round), undefined, closed);
}

/** Length along the path at each point index (control points get their anchor's length). */
function pointLengths(m: PathMeasure): Float64Array {
  const n = m.path.flags.length;
  const out = new Float64Array(n);
  for (let i = 0; i < m.segments.length; i++) {
    const p = m.segmentStartPoint[i];
    out[p] = m.cumulative[i];
    const next = i + 1 < m.segments.length ? m.segmentStartPoint[i + 1] : n;
    for (let q = p + 1; q < next && q < n; q++) out[q] = m.cumulative[i + 1];
  }
  if (n > 0) out[n - 1] = Math.max(out[n - 1], m.cumulative[m.segments.length]);
  return out;
}

export function symbolise(input: SymboliseInput): SymboliseResult {
  return new Stage(input).run();
}

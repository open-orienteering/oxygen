/**
 * Geometry fingerprints over the `RenderSymbol` IR (03 §6.5). Computed
 * from the IR, so the same function serves imported source symbols and
 * canonical library entries; comparison scales the canonical side by the
 * document factor (03 §6.6) and multiplies per-feature tolerance scores
 * (1 inside the tolerance, 0 at twice it). Hard fails short-circuit to 0.
 */

import type { AreaSymbol, Glyph, LineSymbol, LineSymbolBody, PointSymbol, RenderSymbol, TextSymbol } from "../render/symbol.js";
import { type ColourClass, formatClass, sameClass } from "./colour-class.js";

export type ClassOfColour = (colourIdx: number) => ColourClass | null;

export interface Box { w: number; h: number }

export interface LineFingerprint {
  type: "line";
  mainWidth: number | null;
  /** Main stroke colour; for glyph-only or border-only lines the first glyph / border colour. */
  mainClass: ColourClass | null;
  /** Main stroke end / corner shape; null without a main stroke (map-symbols §8.1, C9). */
  cap: string | null;
  join: string | null;
  dashed: boolean;
  dashUm: number | null;
  gapUm: number | null;
  halo: boolean;
  borders: boolean;
  borderWidth: number | null;
  borderShift: number | null;
  borderClass: ColourClass | null;
  background: boolean;
  glyphCount: number;
  glyphPlacement: string | null;
  glyphSpacing: number | null;
  glyphBox: Box | null;
}

export interface AreaFingerprint {
  type: "area";
  fillClass: ColourClass | null | undefined;
  mode: "plain" | "hatch" | "pattern" | "hatch+pattern";
  hatchCount: number;
  hatchWidth: number | null;
  hatchSpacing: number | null;
  hatchAngle: number | null;
  hatchClass: ColourClass | null;
  patternCell: Box | null;
  patternAngle: number | null;
  patternBox: Box | null;
  patternClass: ColourClass | null;
  border: boolean;
  borderWidth: number | null;
}

export interface PointFingerprint {
  type: "point";
  box: Box;
  parts: { stroke: number; fill: number; ring: number; disc: number };
  dominantClass: ColourClass | null;
  orientation: "north" | "object";
  /** Only centred discs/rings — orientation does not apply. */
  symmetric: boolean;
}

export interface TextFingerprint {
  type: "text";
  sizeUm: number;
  weight: number;
  italic: boolean;
  class: ColourClass | null;
}

export type Fingerprint = LineFingerprint | AreaFingerprint | PointFingerprint | TextFingerprint;

/** Bounding box of a glyph in glyph-local µm, stroke widths included. */
export function glyphBox(glyph: Glyph): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number, r = 0) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  };
  for (const p of glyph.parts) {
    if (p.kind === "ring" || p.kind === "disc") {
      add(p.cx ?? 0, p.cy ?? 0, (p.diameterUm ?? 0) / 2);
    } else if (p.geometry) {
      const r = p.kind === "stroke" ? (p.widthUm ?? 0) / 2 : 0;
      const c = p.geometry.coords;
      for (let i = 0; i + 1 < c.length; i += 2) add(c[i], c[i + 1], r);
    }
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}

function dominantClass(glyph: Glyph, classOf: ClassOfColour): ColourClass | null {
  // The colour carrying the most parts; white parts (knock-outs such as the
  // centre of ISSprOM 418) only count when nothing else is drawn; ties go
  // to the first part.
  const classes = glyph.parts.map((p) => classOf(p.colour));
  const inked = classes.some((c) => c && c.hue !== "white");
  const count = new Map<number, number>();
  glyph.parts.forEach((p, i) => {
    if (inked && classes[i]?.hue === "white") return;
    count.set(p.colour, (count.get(p.colour) ?? 0) + 1);
  });
  let best: number | undefined, bestN = 0;
  for (const p of glyph.parts) {
    const n = count.get(p.colour) ?? 0;
    if (n > bestN) { best = p.colour; bestN = n; }
  }
  return best === undefined ? null : classOf(best);
}

/** Discs and rings centred on the origin only — orientation is meaningless. */
function rotationSymmetric(glyph: Glyph): boolean {
  return glyph.parts.every((p) => (p.kind === "disc" || p.kind === "ring") && !(p.cx ?? 0) && !(p.cy ?? 0));
}

/**
 * Mapper's railway paints dashes of the ink over a white band between
 * same-ink rails; the library (and OCAD) paint white dashes over an ink
 * band. The picture is the same with the dash and gap lengths swapped, so
 * the first form is fingerprinted as the second (map-symbols §8.1, A15).
 * Only a dashed main stroke whose borders share its colour class and whose
 * `backgroundColour` is white qualifies; any other colour-order difference
 * stays a hard fail.
 */
function invertedBand(body: LineSymbolBody, classOf: ClassOfColour): Omit<LineFingerprint, "type"> | null {
  const { main, borders: b } = body;
  const rail = b?.left ?? b?.right;
  const rails = [b?.left, b?.right].filter((r) => r !== undefined);
  if (!main?.dash || main.widthUm <= 0 || !rail || b?.backgroundColour === undefined) return null;
  const band = classOf(b.backgroundColour);
  const ink = classOf(main.colour);
  if (band?.hue !== "white" || !ink || ink.hue === "white" || !rails.every((r) => sameClass(ink, classOf(r.colour)))) return null;
  const glyphs = body.glyphs ?? [];
  if (glyphs.length) return null;
  const inner = 2 * rail.shiftUm - rail.widthUm;
  if (inner <= 0) return null;
  return {
    mainWidth: inner, mainClass: band, cap: null, join: null, dashed: true, dashUm: main.dash.gapUm, gapUm: main.dash.dashUm,
    halo: !!main.halo, borders: false, borderWidth: null, borderShift: null, borderClass: null, background: true,
    glyphCount: 0, glyphPlacement: null, glyphSpacing: null, glyphBox: null,
  };
}

/**
 * Cap and join compare as the round-vs-sharp choice only: `flat` and
 * `square` ends are one class, and `bevel` and `miter` joins are one (OCAD's
 * default `lineStyle 0` is flat/bevel and a template set states flat/miter
 * for the same stroke; neither is an explicit choice). `pointed` ends stay
 * their own class.
 */
const capClass = (cap: string) => (cap === "round" || cap === "pointed" ? cap : "flat");
const joinClass = (join: string) => (join === "round" ? "round" : "sharp");

function lineBody(body: LineSymbolBody, classOf: ClassOfColour): Omit<LineFingerprint, "type"> {
  const main = body.main;
  const b = body.borders;
  const border = b?.left ?? b?.right;
  const glyphs = body.glyphs ?? [];
  const first = glyphs[0];
  // A double line whose infill is the border `backgroundColour` (how the
  // library states 502/503) is the same drawing as a main stroke between
  // borders (how OCAD template sets state it): normalise to a main stroke.
  const stroked = !!main && main.widthUm > 0;
  const bgFill = !stroked && b?.backgroundColour !== undefined;
  const bgWidth = bgFill ? (b.backgroundWidthUm ?? (border ? 2 * border.shiftUm - border.widthUm : null)) : null;
  let box: Box | null = null;
  if (first) {
    box = { w: 0, h: 0 };
    for (const g of glyphs) {
      const gb = glyphBox(g.glyph);
      box = { w: Math.max(box.w, gb.w), h: Math.max(box.h, gb.h) };
    }
  }
  const inverted = invertedBand(body, classOf);
  if (inverted) return inverted;
  return {
    mainWidth: stroked ? main.widthUm : bgWidth !== null && bgWidth > 0 ? bgWidth : null,
    mainClass: stroked ? classOf(main.colour) : bgFill ? classOf(b.backgroundColour!) : first ? dominantClass(first.glyph, classOf) : border ? classOf(border.colour) : null,
    cap: stroked ? capClass(main.cap) : null,
    join: stroked ? joinClass(main.join) : null,
    dashed: !!main?.dash,
    dashUm: main?.dash?.dashUm ?? null,
    gapUm: main?.dash?.gapUm ?? null,
    halo: !!main?.halo,
    borders: !!border,
    borderWidth: border?.widthUm ?? null,
    borderShift: border?.shiftUm ?? null,
    borderClass: border ? classOf(border.colour) : null,
    background: stroked && b?.backgroundColour !== undefined,
    glyphCount: glyphs.length,
    glyphPlacement: first ? first.placement.at : null,
    glyphSpacing: first?.placement.at === "spaced" ? first.placement.distanceUm : null,
    glyphBox: box,
  };
}

export function fingerprintOf(sym: RenderSymbol, classOf: ClassOfColour): Fingerprint {
  switch (sym.type) {
    case "line":
      return { type: "line", ...lineBody(sym, classOf) };
    case "area": {
      const hatches = sym.hatches ?? [];
      const patterns = sym.patterns ?? [];
      const h = hatches[0];
      const p = patterns[0];
      const bb = sym.border?.borders;
      const borderStroke = sym.border?.main ?? bb?.left ?? bb?.right;
      return {
        type: "area",
        fillClass: sym.fill === undefined ? undefined : classOf(sym.fill),
        mode: hatches.length && patterns.length ? "hatch+pattern" : hatches.length ? "hatch" : patterns.length ? "pattern" : "plain",
        hatchCount: hatches.length,
        hatchWidth: h?.widthUm ?? null,
        hatchSpacing: h?.spacingUm ?? null,
        hatchAngle: h ? ((h.angleDeg % 180) + 180) % 180 : null,
        hatchClass: h ? classOf(h.colour) : null,
        patternCell: p ? { w: p.cellWidthUm, h: p.cellHeightUm } : null,
        patternAngle: p ? ((p.angleDeg % 180) + 180) % 180 : null,
        patternBox: p ? glyphBox(p.glyph) : null,
        patternClass: p ? dominantClass(p.glyph, classOf) : null,
        border: !!borderStroke && borderStroke.widthUm > 0,
        borderWidth: borderStroke && borderStroke.widthUm > 0 ? borderStroke.widthUm : null,
      };
    }
    case "point": {
      const parts = { stroke: 0, fill: 0, ring: 0, disc: 0 };
      for (const p of sym.glyph.parts) parts[p.kind]++;
      return { type: "point", box: glyphBox(sym.glyph), parts, dominantClass: dominantClass(sym.glyph, classOf), orientation: sym.orientation, symmetric: rotationSymmetric(sym.glyph) };
    }
    case "text":
      return { type: "text", sizeUm: sym.digitHeightUm ? sym.digitHeightUm / 0.716 : sym.fontSizeUm, weight: sym.weight, italic: sym.italic, class: classOf(sym.colour) };
  }
}

/** Starting tolerances (03 §6.5), paper µm / degrees at the *source* scale. */
export const TOLERANCE = { widthUm: 20, lengthUm: 100, angleDeg: 5, textFraction: 0.1, boxFraction: 0.1 } as const;

/** Each element more or fewer (a second ring, a missing dash glyph) multiplies the score by this. */
export const COUNT_PENALTY = 0.6;

/**
 * Cap and join each differing multiplies the score by this: a tie-break
 * between variants of one family (OCAD's round no-tag cliff vs the flat
 * tagged one), never a structural fail, so a perfect geometric match with
 * the other cap still auto-matches when no variant of its own exists.
 */
export const CAP_JOIN_PENALTY = 0.95;

export interface Comparison {
  /** Product of the feature scores; 0 on a hard fail. */
  score: number;
  /** Human-readable feature notes, shown in review. */
  reasons: string[];
  /** The part of `score` owed to cap / join mismatches (1 when they agree); the geometry-only stage divides it out. */
  capJoin: number;
  hardFail?: string;
}

/** 1 inside `tol`, linearly down to 0 at `2 × tol`. */
export function toleranceScore(diff: number, tol: number): number {
  const d = Math.abs(diff);
  if (d <= tol) return 1;
  if (d >= 2 * tol) return 0;
  return 1 - (d - tol) / tol;
}

const fmt = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

class Scorer {
  score = 1;
  readonly reasons: string[] = [];
  hardFail?: string;
  capJoin = 1;
  readonly factor: number;
  constructor(factor: number) {
    this.factor = factor;
  }

  /** Compare a source value with a canonical one (scaled by the factor). Missing on both sides is neutral; on one side costs `missingScore`. */
  length(label: string, src: number | null, canon: number | null, tol: number, missingScore = 0.5): void {
    if (src === null && canon === null) return;
    if (src === null || canon === null) {
      this.mul(missingScore, `${label} ${fmt(src)} vs ${fmt(canon === null ? null : canon * this.factor)} µm`);
      return;
    }
    const c = canon * this.factor;
    this.mul(toleranceScore(src - c, tol * this.factor), `${label} ${fmt(src)} vs ${fmt(c)} µm`);
  }

  angle(label: string, src: number | null, canon: number | null): void {
    if (src === null && canon === null) return;
    if (src === null || canon === null) return this.mul(0.5, `${label} ${fmt(src)} vs ${fmt(canon)}°`);
    let d = Math.abs(src - canon) % 180;
    d = Math.min(d, 180 - d);
    this.mul(toleranceScore(d, TOLERANCE.angleDeg), `${label} ${fmt(src)} vs ${fmt(canon)}°`);
  }

  count(label: string, src: number, canon: number): void {
    const diff = Math.abs(src - canon);
    if (diff) this.mul(COUNT_PENALTY ** diff, `${label} ${src} vs ${canon}`);
  }

  flag(label: string, src: boolean, canon: boolean, penalty: number): void {
    if (src !== canon) this.mul(penalty, `${label} ${src ? "yes" : "no"} vs ${canon ? "yes" : "no"}`);
  }

  mismatch(label: string, src: string, canon: string, penalty: number): void {
    if (src === canon) return;
    this.capJoin *= penalty;
    this.mul(penalty, `${label} ${src} vs ${canon}`);
  }

  box(label: string, src: Box | null, canon: Box | null): void {
    if (src === null && canon === null) return;
    if (src === null || canon === null) return this.mul(0.5, `${label} present on one side only`);
    // Glyph extents scale with the symbol (a 5 mm control ring vs a 0.4 mm
    // dot), so the tolerance is the larger of the absolute one and 10 %.
    this.length(`${label} width`, src.w, canon.w, Math.max(TOLERANCE.lengthUm, canon.w * TOLERANCE.boxFraction));
    this.length(`${label} height`, src.h, canon.h, Math.max(TOLERANCE.lengthUm, canon.h * TOLERANCE.boxFraction));
  }

  classes(label: string, src: ColourClass | null | undefined, canon: ColourClass | null | undefined, hard: boolean): void {
    // Neither side has a colour here (both absent, or both unclassifiable): nothing to compare.
    if (!src && !canon) return;
    if (sameClass(src ?? null, canon ?? null)) return;
    const msg = `${label} ${formatClass(src)} ≠ ${formatClass(canon)}`;
    if (hard) this.fail(msg);
    else this.mul(0.5, msg);
  }

  fail(msg: string): void {
    this.hardFail ??= msg;
    this.score = 0;
    this.reasons.push(msg);
  }

  private mul(s: number, reason: string): void {
    if (s < 1) this.reasons.push(`${reason} (${s.toFixed(2)})`);
    this.score *= s;
  }

  result(): Comparison {
    const out: Comparison = { score: this.hardFail ? 0 : Math.round(this.score * 1000) / 1000, reasons: this.reasons, capJoin: this.capJoin };
    if (this.hardFail) out.hardFail = this.hardFail;
    return out;
  }
}

/**
 * Score how well a canonical fingerprint (library entry, reference-scale
 * dimensions) describes a source fingerprint when scaled by `factor`.
 */
export function compareFingerprints(src: Fingerprint, canon: Fingerprint, factor = 1): Comparison {
  const s = new Scorer(factor);
  if (src.type !== canon.type) {
    s.fail(`type ${src.type} ≠ ${canon.type}`);
    return s.result();
  }
  switch (src.type) {
    case "line": {
      const c = canon as LineFingerprint;
      // Hard when both sides have the same structure (both stroked, or both
      // glyph-/border-only); a glyph-only line against a stroked one is a
      // structural difference scored softly instead.
      const sameStructure = (src.mainWidth === null) === (c.mainWidth === null);
      s.classes("main colour", src.mainClass, c.mainClass, sameStructure);
      if (s.hardFail) break;
      if ((src.mainWidth === null) !== (c.mainWidth === null)) s.flag("main stroke", src.mainWidth !== null, c.mainWidth !== null, 0.5);
      if (src.dashed !== c.dashed) { s.fail(`dashed ${src.dashed} ≠ ${c.dashed}`); break; }
      if (src.borders !== c.borders) { s.fail(`borders ${src.borders} ≠ ${c.borders}`); break; }
      s.length("main width", src.mainWidth, c.mainWidth, TOLERANCE.widthUm);
      if (src.cap !== null && c.cap !== null) s.mismatch("cap", src.cap, c.cap, CAP_JOIN_PENALTY);
      if (src.join !== null && c.join !== null) s.mismatch("join", src.join, c.join, CAP_JOIN_PENALTY);
      s.length("dash", src.dashUm, c.dashUm, TOLERANCE.lengthUm);
      s.length("gap", src.gapUm, c.gapUm, TOLERANCE.lengthUm);
      s.flag("halo", src.halo, c.halo, 0.7);
      if (src.borders) {
        s.length("border width", src.borderWidth, c.borderWidth, TOLERANCE.widthUm);
        s.length("border shift", src.borderShift, c.borderShift, TOLERANCE.lengthUm);
        s.classes("border colour", src.borderClass, c.borderClass, false);
        s.flag("background", src.background, c.background, 0.7);
      }
      // Tags, dots or bars on one side only (202 vs 202.b) is a different symbol, not a count off by one.
      if ((src.glyphCount === 0) !== (c.glyphCount === 0)) s.flag("glyphs", src.glyphCount > 0, c.glyphCount > 0, 0.6);
      else s.count("glyphs", src.glyphCount, c.glyphCount);
      if (src.glyphCount && c.glyphCount) {
        if (src.glyphPlacement !== c.glyphPlacement) s.flag("glyph placement", true, false, 0.5);
        s.length("glyph spacing", src.glyphSpacing, c.glyphSpacing, TOLERANCE.lengthUm);
        s.box("glyph box", src.glyphBox, c.glyphBox);
      }
      break;
    }
    case "area": {
      const c = canon as AreaFingerprint;
      if ((src.fillClass === undefined) !== (c.fillClass === undefined)) { s.fail(`fill ${src.fillClass === undefined ? "absent" : "present"} ≠ ${c.fillClass === undefined ? "absent" : "present"}`); break; }
      s.classes("fill colour", src.fillClass, c.fillClass, true);
      if (s.hardFail) break;
      if (src.mode !== c.mode) { s.fail(`mode ${src.mode} ≠ ${c.mode}`); break; }
      if (src.hatchCount || c.hatchCount) {
        s.count("hatches", src.hatchCount, c.hatchCount);
        s.length("hatch width", src.hatchWidth, c.hatchWidth, TOLERANCE.widthUm);
        s.length("hatch spacing", src.hatchSpacing, c.hatchSpacing, TOLERANCE.lengthUm);
        s.angle("hatch angle", src.hatchAngle, c.hatchAngle);
        s.classes("hatch colour", src.hatchClass, c.hatchClass, true);
      }
      if (src.patternCell || c.patternCell) {
        s.box("pattern cell", src.patternCell, c.patternCell);
        s.angle("pattern angle", src.patternAngle, c.patternAngle);
        s.box("pattern glyph", src.patternBox, c.patternBox);
        s.classes("pattern colour", src.patternClass, c.patternClass, true);
      }
      s.flag("border", src.border, c.border, 0.6);
      if (src.border && c.border) s.length("border width", src.borderWidth, c.borderWidth, TOLERANCE.widthUm);
      break;
    }
    case "point": {
      const c = canon as PointFingerprint;
      s.classes("colour", src.dominantClass, c.dominantClass, true);
      if (s.hardFail) break;
      s.box("glyph", src.box, c.box);
      s.count("strokes", src.parts.stroke, c.parts.stroke);
      s.count("fills", src.parts.fill, c.parts.fill);
      s.count("rings", src.parts.ring, c.parts.ring);
      s.count("discs", src.parts.disc, c.parts.disc);
      if (!src.symmetric || !c.symmetric) s.flag("north-oriented", src.orientation === "north", c.orientation === "north", 0.8);
      break;
    }
    case "text": {
      const c = canon as TextFingerprint;
      s.classes("colour", src.class, c.class, true);
      if (s.hardFail) break;
      s.length("size", src.sizeUm, c.sizeUm, c.sizeUm * TOLERANCE.textFraction);
      s.flag("bold", src.weight >= 600, c.weight >= 600, 0.8);
      s.flag("italic", src.italic, c.italic, 0.8);
      break;
    }
  }
  return s.result();
}

/** FNV-1a over the fingerprint's JSON — the `irHash` that keys club decisions (06 §5.3). */
export function fingerprintHash(fp: Fingerprint): string {
  const s = JSON.stringify(fp);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

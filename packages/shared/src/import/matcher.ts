/**
 * Staged symbol matcher (03 §6.5; 06 stage 6): source symbol → canonical
 * library entry, with the stage that decided, a confidence and reasons.
 *
 *   1 explicit        a club / user decision for (code, name[, irHash])
 *   2 code+geometry   same spec code, fingerprint ≥ T_auto
 *   3 family+geometry same base number (else hundred group); ≥ T_auto auto, ≥ T_suggest suggested
 *   4 geometry        every entry of the IR type; ≥ T_strict → suggested, never auto
 *   5 description     name tokens (sv → en lexicon) when geometry is inconclusive → suggested
 *   6 none
 *
 * The document factor (03 §6.6) is detected first from the exact-code line
 * families and every comparison scales the canonical side by it.
 */

import type { SymbolMatch } from "../map-document/header.js";
import type { RenderSymbol } from "../render/symbol.js";
import { getSymbolLibrary, SYMBOL_LIBRARY_VERSION, type SymbolLibraryId } from "../symbol-library/index.js";
import { type PaletteEdition, paletteIndex, paletteStack } from "../symbol-library/palette.js";
import { type LibraryEntry, resolveEntry, type SymbolLibrary } from "../symbol-library/schema.js";
import { paletteClass } from "./colour-class.js";
import { type ClassOfColour, compareFingerprints, type Comparison, type Fingerprint, fingerprintHash, fingerprintOf } from "./fingerprint.js";

/** 03 §6.5 starting thresholds; reported in the import summary so tuning is visible. */
export const MATCH_THRESHOLDS = { auto: 0.85, suggest: 0.6, strict: 0.95 } as const;

/** Plausible symbol scale factors; the detected median snaps to one within 3 %. */
export const FACTOR_SNAP = [0.5, 0.667, 0.75, 1, 1.2, 1.333, 1.5, 2] as const;

/** A reviewed decision reused across documents of a club (06 §5.3). `canonicalId: null` keeps the source drawing. */
export interface SymbolDecision {
  code: string;
  name?: string;
  irHash?: string;
  canonicalId: string | null;
  /** The library the decision was made against; `matchDocument` drops decisions of another library (docs/map-symbols.md §8.5). */
  libraryId?: string;
}

export interface CanonicalCandidate {
  entry: LibraryEntry;
  /** The entry's code as the library writes it (`"505"`, `"105.1"`). */
  code: string;
  base: string;
  hundred: string;
  fp: Fingerprint;
}

/** `"101.0"` → `"101"`, `"505.1"` → `"505.1"`, anything else unchanged. */
export function normaliseCode(code: string): string {
  const m = /^(\d{3})(?:\.(\d{1,3}))?$/.exec(code.trim());
  if (!m) return code.trim();
  const sub = m[2] ? String(Number(m[2])) : "";
  return sub && sub !== "0" ? `${m[1]}.${sub}` : m[1];
}
export const baseCode = (code: string): string => normaliseCode(code).slice(0, 3);
const hundredOf = (code: string): string => normaliseCode(code).slice(0, 1);

/** 03 §6.5: ISSprOM for sprint scales, ISOM otherwise; the caller may override. */
export function chooseLibrary(mapScale: number, override?: SymbolLibraryId): SymbolLibraryId {
  if (override) return override;
  return mapScale <= 5000 ? "ISSprOM2019-2" : "ISOM2017-2";
}

const canonicalCache = new Map<string, CanonicalCandidate[]>();

/** Library entries resolved against their own palette and fingerprinted with palette colour classes. */
export function canonicalCandidates(library: SymbolLibrary, edition: PaletteEdition): CanonicalCandidate[] {
  const key = `${library.id}:${edition}`;
  let list = canonicalCache.get(key);
  if (!list) {
    const index = paletteIndex(edition, library.spec);
    const stack = paletteStack(edition, library.spec);
    const classOf: ClassOfColour = (i) => paletteClass(stack[i].id.replace(/^[^:]+:/, ""), edition);
    list = library.entries.map((entry) => {
      const render = resolveEntry(entry, index);
      return { entry, code: entry.code, base: baseCode(entry.code), hundred: hundredOf(entry.code), fp: fingerprintOf(render, classOf) };
    });
    canonicalCache.set(key, list);
  }
  return list;
}

export interface SourceSymbolLike {
  code: string;
  name: string;
  render: RenderSymbol | null;
}

export interface FactorDetection {
  factor: number;
  /** Factor the map scale alone implies (reference / map). */
  scaleFactor: number;
  /** `factor / scaleFactor` — 1 when the map is drawn at the spec's enlargement for its scale. */
  symbolScale: number;
  /** `lines` = width median; `codes` = exact-code fit when no line family is usable; `scale` = map scale alone. */
  method: "lines" | "codes" | "scale" | "override";
  samples: { code: string; ratio: number }[];
  rawMedian: number | null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function snapFactor(raw: number): number {
  for (const f of FACTOR_SNAP) if (Math.abs(raw - f) / f <= 0.03) return f;
  return Math.round(raw * 1000) / 1000;
}

/** 03 §6.6: median over exact-code line families of source width ÷ canonical width, snapped. */
export function detectDocumentFactor(
  symbols: readonly SourceSymbolLike[],
  canon: readonly CanonicalCandidate[],
  classOf: ClassOfColour,
  mapScale: number,
  referenceScale: number,
  override?: number,
): FactorDetection {
  const scaleFactor = Math.round((referenceScale / mapScale) * 1000) / 1000;
  if (override !== undefined) return { factor: override, scaleFactor, symbolScale: round3(override / scaleFactor), method: "override", samples: [], rawMedian: null };
  const perFamily = new Map<string, number[]>();
  const samples: FactorDetection["samples"] = [];
  for (const s of symbols) {
    if (!s.render || s.render.type !== "line" || !s.render.main || s.render.main.widthUm <= 0) continue;
    const code = normaliseCode(s.code);
    // The entry with this exact code, else the family heading ("101.1 Contour"
    // in the OCAD template sets is spec 101) — both must be stroked lines of
    // the same hue, so sub-numbered variants of another kind are skipped.
    const isLineHeading = (c: CanonicalCandidate) => c.fp.type === "line" && c.fp.mainWidth !== null;
    const heading = canon.find((c) => c.code === code && isLineHeading(c)) ?? canon.find((c) => c.code === baseCode(code) && c.entry.variant === null && isLineHeading(c));
    if (!heading || heading.fp.type !== "line" || heading.fp.mainWidth === null) continue;
    const srcFp = fingerprintOf(s.render, classOf);
    if (srcFp.type !== "line" || !srcFp.mainClass || !heading.fp.mainClass || srcFp.mainClass.hue !== heading.fp.mainClass.hue) continue;
    if (srcFp.dashed !== heading.fp.dashed || srcFp.borders !== heading.fp.borders) continue;
    const ratio = s.render.main.widthUm / heading.fp.mainWidth;
    samples.push({ code, ratio: round3(ratio) });
    const fam = perFamily.get(heading.base) ?? [];
    fam.push(ratio);
    perFamily.set(heading.base, fam);
  }
  if (perFamily.size === 0) {
    // No solid line family to measure: try the scale's factor against ×1 on
    // the exact-code symbols of every type and keep the one more of them fit
    // (a map "enlarged" to 1:7500 that still carries 1:15000 dimensions).
    const scaled = snapFactor(scaleFactor);
    const candidates = [...new Set([scaled, 1])];
    const fits = candidates.map((f) => exactCodeFits(symbols, canon, classOf, f));
    const best = fits.indexOf(Math.max(...fits));
    if (fits[best] > 0 && candidates[best] !== scaled) {
      return { factor: candidates[best], scaleFactor, symbolScale: round3(candidates[best] / scaleFactor), method: "codes", samples, rawMedian: null };
    }
    return { factor: scaled, scaleFactor, symbolScale: 1, method: "scale", samples, rawMedian: null };
  }
  const raw = median([...perFamily.values()].map(median));
  const factor = snapFactor(raw);
  return { factor, scaleFactor, symbolScale: round3(factor / scaleFactor), method: "lines", samples, rawMedian: round3(raw) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Number of source symbols whose exact-code library entry fits at `factor` (≥ T_auto). */
function exactCodeFits(symbols: readonly SourceSymbolLike[], canon: readonly CanonicalCandidate[], classOf: ClassOfColour, factor: number): number {
  let n = 0;
  for (const s of symbols) {
    if (!s.render) continue;
    const code = normaliseCode(s.code);
    const c = canon.find((x) => x.code === code && x.fp.type === s.render!.type);
    if (!c) continue;
    const cmp = compareFingerprints(fingerprintOf(s.render, classOf), c.fp, factor);
    if (!cmp.hardFail && cmp.score >= MATCH_THRESHOLDS.auto) n++;
  }
  return n;
}

/**
 * Names that mark a symbol as a template variant of its family rather than
 * a reused number: minimum-size pieces, single pattern elements, outlines.
 */
export const VARIANT_NAME = /minimi|minimum|\bmin\b|enskild|single|individual|kontur|outline|border|boundary|begränsning|sidlinje|kantlinje|baslinje|\bdot\b|linje\)|punkt\)|element|gräns/i;

// ---- description tokens -----------------------------------------------------

const STOPWORDS = new Set(["och", "med", "utan", "för", "av", "i", "på", "the", "and", "with", "without", "of", "for", "in", "or", "a", "an", "to", "stor", "liten", "large", "small", "minimum", "min", "yta", "linje", "punkt", "area", "line", "point", "symbol"]);

/** Swedish map vocabulary → the library's English words. */
const SV_EN: Record<string, string> = {
  höjdkurva: "contour", stödkurva: "index contour", hjälpkurva: "form line", lutningsstreck: "slope line", skärning: "earth bank", jordvall: "earth wall",
  brant: "cliff", sten: "boulder", stenar: "boulder", block: "boulder", blockterräng: "boulder field", stenig: "stony", grop: "pit", hål: "pit", sänka: "depression", kulle: "knoll", punkthöjd: "knoll",
  sankmark: "marsh", kärr: "marsh", vattendrag: "stream", bäck: "stream", dike: "ditch", sjö: "lake", vatten: "water", vattenyta: "water", brunn: "well", källa: "spring",
  stig: "footpath", väg: "road", vägar: "road", gata: "road", staket: "fence", stängsel: "fence", mur: "wall", stenmur: "stone wall", byggnad: "building", hus: "building", ruin: "ruin",
  torn: "tower", kraftledning: "power line", järnväg: "railway", tunnel: "tunnel", bro: "bridge", trappa: "stairs", skärmtak: "canopy", tak: "canopy",
  start: "start", mål: "finish", kontroll: "control", kontrollpunkt: "control point", kontrollnummer: "control number", förbjudet: "out-of-bounds", område: "area",
  odlad: "cultivated", åker: "cultivated land", öppen: "open", mark: "land", skog: "forest", vegetation: "vegetation", gräns: "boundary", nordlinje: "magnetic north line",
  träd: "tree", buske: "bush", häck: "hedge", sand: "sand", berg: "bare rock", hällmark: "bare rock", grus: "gravel", parkering: "paved", asfalt: "paved", belagd: "paved",
  tydlig: "prominent", tydligt: "prominent", särpräglad: "prominent", särpräglat: "prominent", människoframställt: "man-made", föremål: "feature", objekt: "feature",
  stödmur: "retaining wall", undergång: "underpass", passage: "passage", kant: "edge", steg: "step", trappsteg: "step", pelare: "pillar", stolpe: "pillar",
  röse: "cairn", minnessten: "monument", monument: "monument", fontän: "fountain", vattenreservoar: "water tank", linbana: "cable car", skidlift: "ski lift",
  grotta: "cave", spång: "footbridge", stenbrott: "quarry", gruvhål: "pit", häll: "bare rock", sandområde: "sand", beträdas: "entered", gångbana: "footpath", gångväg: "footpath",
};

export function descriptionTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^\p{L}]+/u)) {
    if (!raw) continue;
    const t = SV_EN[raw] ?? raw;
    for (const w of t.split(/[\s-]+/)) if (w && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

// ---- matching ----------------------------------------------------------------

export interface MatchContext {
  library: SymbolLibrary;
  libraryId: SymbolLibraryId;
  edition: PaletteEdition;
  canon: readonly CanonicalCandidate[];
  factor: number;
  classOf: ClassOfColour;
  decisions?: readonly SymbolDecision[];
}

export interface MatchOutcome {
  match: SymbolMatch;
  /** Set when a line symbol only matches at another factor (03 §6.6 anomaly). */
  scaleAnomaly?: { factor: number; canonicalId: string };
  /** A decision named an entry the library does not have. */
  unknownDecision?: string;
}

interface Scored { cand: CanonicalCandidate; cmp: Comparison }

function scoreAll(fp: Fingerprint, pool: readonly CanonicalCandidate[], factor: number): Scored[] {
  return pool
    .map((cand) => ({ cand, cmp: compareFingerprints(fp, cand.fp, factor) }))
    .sort((a, b) => b.cmp.score - a.cmp.score || a.cand.entry.id.localeCompare(b.cand.entry.id));
}

const libraryVersion = (ctx: MatchContext) => `${ctx.library.id}@${SYMBOL_LIBRARY_VERSION}`;

function describe(best: Scored, factor: number): string[] {
  const head = `${best.cand.entry.id} ${best.cmp.hardFail ? "hard fail" : best.cmp.score.toFixed(2)}${factor !== 1 ? ` at ×${factor}` : ""}`;
  return [head, ...best.cmp.reasons.slice(0, 6)];
}

function alternatives(scored: Scored[], skip: CanonicalCandidate | undefined): SymbolMatch["alternatives"] {
  const alts = scored.filter((s) => s.cand !== skip && s.cmp.score > 0).slice(0, 3).map((s) => ({ canonicalId: s.cand.entry.id, confidence: s.cmp.score }));
  return alts.length ? alts : undefined;
}

export function symbolIrHash(render: RenderSymbol, classOf: ClassOfColour): string {
  return fingerprintHash(fingerprintOf(render, classOf));
}

export function matchSymbol(sym: SourceSymbolLike, ctx: MatchContext): MatchOutcome {
  const version = libraryVersion(ctx);
  const code = normaliseCode(sym.code);
  const none = (reasons: string[]): SymbolMatch => ({ canonicalId: null, method: "none", state: "unmatched", confidence: 0, reasons, reviewed: false, libraryVersion: version });

  if (!sym.render) return { match: none(["no render definition"]) };
  const fp = fingerprintOf(sym.render, ctx.classOf);

  // 1 explicit
  if (ctx.decisions?.length) {
    const hash = symbolIrHash(sym.render, ctx.classOf);
    const d = ctx.decisions.find((d) => normaliseCode(d.code) === code && (d.name === undefined || d.name === sym.name) && (d.irHash === undefined || d.irHash === hash));
    if (d) {
      if (d.canonicalId === null) {
        return { match: { canonicalId: null, method: "explicit", state: "unmatched", confidence: 1, reasons: ["kept as source by decision"], reviewed: true, libraryVersion: version } };
      }
      const entry = ctx.canon.find((c) => c.entry.id === d.canonicalId);
      if (entry) {
        return { match: { canonicalId: entry.entry.id, method: "explicit", state: "auto", confidence: 1, reasons: ["by decision"], reviewed: true, libraryVersion: version } };
      }
      // Fall through to the geometric stages, but report the dangling decision.
      const out = matchGeometric(sym, code, fp, ctx, version, none);
      out.unknownDecision = d.canonicalId;
      out.match.reasons.unshift(`decision names ${d.canonicalId}, which is not in ${ctx.library.id}`);
      return out;
    }
  }
  return matchGeometric(sym, code, fp, ctx, version, none);
}

function matchGeometric(sym: SourceSymbolLike, code: string, fp: Fingerprint, ctx: MatchContext, version: string, none: (r: string[]) => SymbolMatch): MatchOutcome {
  const { canon, factor } = ctx;
  const base = baseCode(code);
  const sameType = canon.filter((c) => c.fp.type === fp.type);

  // 2 code + geometry
  const exact = canon.filter((c) => c.code === code);
  const exactScored = scoreAll(fp, exact, factor);
  if (exactScored[0] && exactScored[0].cmp.score >= MATCH_THRESHOLDS.auto) {
    const best = exactScored[0];
    return { match: { canonicalId: best.cand.entry.id, method: "code+geometry", state: "auto", confidence: best.cmp.score, reasons: describe(best, factor), reviewed: false, libraryVersion: version, alternatives: alternatives(exactScored, best.cand) } };
  }

  // 3 family + geometry
  let family = canon.filter((c) => c.base === base);
  if (family.length === 0) family = canon.filter((c) => c.hundred === hundredOf(code));
  const familyScored = scoreAll(fp, family, factor);
  const famBest = familyScored[0];
  if (famBest && famBest.cmp.score >= MATCH_THRESHOLDS.suggest) {
    const state = famBest.cmp.score >= MATCH_THRESHOLDS.auto ? "auto" : "suggested";
    const method = exact.includes(famBest.cand) ? "code+geometry" : "family+geometry";
    return { match: { canonicalId: famBest.cand.entry.id, method, state, confidence: famBest.cmp.score, reasons: describe(famBest, factor), reviewed: false, libraryVersion: version, alternatives: alternatives(familyScored, famBest.cand) } };
  }

  // A symbol numbered into a known family but of another IR kind — "521.3
  // Byggnad (minimimått)" as a point, "501.4 Paved Area Boundary" as a line
  // — is a deliberate template variant (minimum-size, single element,
  // outline). Geometry-only matches to unrelated symbols of its own kind
  // (a stony-ground dot is also a spot-height dot) would be wrong, and the
  // library has no entry for it: drawn from source, no suggestion.
  const familyKinds = new Set(family.map((c) => c.fp.type));
  if (family.length && !familyKinds.has(fp.type) && VARIANT_NAME.test(sym.name)) {
    const lead = `${fp.type} variant of ${[...familyKinds].join("/")} symbol ${base} (minimum-size, single-element or outline); drawn from source`;
    return { match: { ...none([lead, ...(famBest ? describe(famBest, factor) : [])]), method: "variant" } };
  }

  // 4 geometry only — same hundred group first, then description overlap, then id, as tie-breaks
  const srcTokens = descriptionTokens(sym.name);
  const overlap = (c: CanonicalCandidate) => [...descriptionTokens(c.entry.name.en)].filter((t) => srcTokens.has(t)).length;
  const geoScored = scoreAll(fp, sameType, factor).sort((a, b) =>
    b.cmp.score - a.cmp.score
    || Number(b.cand.hundred === hundredOf(code)) - Number(a.cand.hundred === hundredOf(code))
    || overlap(b.cand) - overlap(a.cand)
    || a.cand.entry.id.localeCompare(b.cand.entry.id));
  const geoBest = geoScored[0];
  if (geoBest && geoBest.cmp.score >= MATCH_THRESHOLDS.strict) {
    return { match: { canonicalId: geoBest.cand.entry.id, method: "geometry", state: "suggested", confidence: geoBest.cmp.score, reasons: describe(geoBest, factor), reviewed: false, libraryVersion: version, alternatives: alternatives(geoScored, geoBest.cand) } };
  }

  // 03 §6.6 anomaly: an exact-code line that matches only at another factor.
  let scaleAnomaly: MatchOutcome["scaleAnomaly"];
  if (exact.length && fp.type === "line") {
    for (const f of FACTOR_SNAP) {
      if (f === factor) continue;
      const alt = scoreAll(fp, exact, f)[0];
      if (alt && alt.cmp.score >= MATCH_THRESHOLDS.auto) { scaleAnomaly = { factor: f, canonicalId: alt.cand.entry.id }; break; }
    }
  }

  // 5 description — only candidates the geometry does not rule out outright
  // (same IR type, no colour-class or structural hard fail): a brown road
  // must not be suggested as a black edge line just because the names overlap.
  // A single shared word is enough when the candidate carries the source's
  // own code or the geometry is at least partly compatible; otherwise two.
  const geoByCand = new Map(geoScored.map((x) => [x.cand, x.cmp]));
  const described = sameType
    .filter((c) => !geoByCand.get(c)?.hardFail)
    .map((c) => ({ c, n: overlap(c) }))
    .filter((x) => x.n >= 2 || (x.n === 1 && (x.c.code === code || (geoByCand.get(x.c)?.score ?? 0) > 0)))
    .sort((a, b) => b.n - a.n || Number(b.c.hundred === hundredOf(code)) - Number(a.c.hundred === hundredOf(code)) || a.c.entry.id.localeCompare(b.c.entry.id));
  const reasonsFor = (lead: string[]): string[] => {
    const r = [...lead];
    const why = famBest ?? geoBest ?? exactScored[0];
    if (why) r.push(...describe(why, factor));
    if (scaleAnomaly) r.push(`matches ${scaleAnomaly.canonicalId} at ×${scaleAnomaly.factor} (document factor ×${factor})`);
    return r;
  };
  if (described[0]) {
    const confidence = Math.min(0.5, 0.3 + 0.1 * described[0].n);
    const out: MatchOutcome = {
      match: { canonicalId: described[0].c.entry.id, method: "description", state: "suggested", confidence, reasons: reasonsFor([`name "${sym.name}" ~ ${described[0].c.entry.name.en}`]), reviewed: false, libraryVersion: version },
    };
    if (scaleAnomaly) out.scaleAnomaly = scaleAnomaly;
    return out;
  }

  // 6 none
  let reason = exact.length || family.length ? "no candidate above threshold" : "no candidate";
  if (famBest?.cmp.hardFail) reason = `nearest ${famBest.cand.entry.id}: ${famBest.cmp.hardFail}`;
  const out: MatchOutcome = { match: none(reasonsFor([reason])) };
  if (scaleAnomaly) out.scaleAnomaly = scaleAnomaly;
  return out;
}

export function matchContext(libraryId: SymbolLibraryId, edition: PaletteEdition, factor: number, classOf: ClassOfColour, decisions?: readonly SymbolDecision[]): MatchContext {
  const library = getSymbolLibrary(libraryId);
  const ctx: MatchContext = { library, libraryId, edition, canon: canonicalCandidates(library, edition), factor, classOf };
  if (decisions) ctx.decisions = decisions;
  return ctx;
}

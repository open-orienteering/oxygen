/**
 * Club symbol decisions and the review rows they are made on (06 §5.1,
 * §5.3). Pure; the API persists the rows (`club_symbol_decisions`) and
 * builds URLs. Normative: docs/map-symbols.md §8.5.
 */

import type { DocumentColour, DocumentSymbol, SymbolMatch } from "../map-document/header.js";
import { parseRenderSymbol, type RenderSymbol } from "../render/symbol.js";
import { getSymbolLibrary, isSymbolLibraryId } from "../symbol-library/index.js";
import type { PaletteEdition } from "../symbol-library/palette.js";
import { classifyColour, detectPaletteEdition, formatClass } from "./colour-class.js";
import { type ClassOfColour, compareFingerprints, type Fingerprint, fingerprintOf } from "./fingerprint.js";
import { baseCode, chooseLibrary, matchContext, matchSymbol, normaliseCode, type SymbolDecision, symbolIrHash } from "./matcher.js";

// ---- fingerprints -------------------------------------------------------------

/** `"<source kind>:<normalised code>:<irHash>"` — readable, so a CRT comment can carry it. */
export function decisionFingerprint(kind: string, code: string, irHash: string): string {
  return `${kind}:${normaliseCode(code)}:${irHash}`;
}

export function parseDecisionFingerprint(fingerprint: string): { kind: string; code: string; irHash: string } | null {
  const m = /^([a-z0-9-]+):([^:]+):([0-9a-f]{8})$/.exec(fingerprint);
  return m ? { kind: m[1], code: m[2], irHash: m[3] } : null;
}

/** Colour classes are per colour, so the aligned stack of a stored header classifies like the source stack did. */
export function documentClassOf(colours: readonly Pick<DocumentColour, "name" | "cmyk">[]): ClassOfColour {
  const classes = colours.map((c) => classifyColour(c).class ?? null);
  return (i) => classes[i] ?? null;
}

/** A stored header or an encoder input: `origin` may be defaulted, `render` parsed or not. */
interface SymbolLike {
  code: string;
  origin?: DocumentSymbol["origin"];
  render: unknown;
  match?: Pick<SymbolMatch, "method" | "canonicalId">;
}

interface HeaderLike {
  source: { kind: string };
  colours: readonly Pick<DocumentColour, "name" | "cmyk">[];
  symbols: readonly SymbolLike[];
}

const isSource = (s: { origin?: DocumentSymbol["origin"] }) => (s.origin ?? "source") === "source";

/** Fingerprint per header symbol; `null` for non-source symbols and symbols without a render. */
export function documentSymbolFingerprints(header: HeaderLike): (string | null)[] {
  const classOf = documentClassOf(header.colours);
  return header.symbols.map((s) => (isSource(s) && s.render ? decisionFingerprint(header.source.kind, s.code, symbolIrHash(parseRenderSymbol(s.render), classOf)) : null));
}

// ---- rows → matcher decisions -------------------------------------------------

export interface ClubDecisionRow {
  fingerprint: string;
  /** `<library>@<release>` the decision was made against. */
  libraryVersion: string;
  canonicalId: string | null;
  decidedAt: Date;
}

/** `ISOM2017-2@2026.10.1` → `ISOM2017-2`; `null` for `none` or anything without a release. */
export function libraryIdOfVersion(libraryVersion: string): string | null {
  const at = libraryVersion.indexOf("@");
  return at > 0 ? libraryVersion.slice(0, at) : null;
}

/**
 * The decisions stage 6 applies for a source of `kind`: per (fingerprint,
 * library id) the newest `decided_at` across releases wins, ties to the
 * later release string (docs/map-symbols.md §8.5). Sorted, so the job
 * snapshot is stable.
 */
export function decisionsFromRows(rows: readonly ClubDecisionRow[], kind: string): SymbolDecision[] {
  const best = new Map<string, ClubDecisionRow>();
  for (const r of rows) {
    const fp = parseDecisionFingerprint(r.fingerprint);
    const lib = libraryIdOfVersion(r.libraryVersion);
    if (!fp || fp.kind !== kind || !lib) continue;
    const key = `${r.fingerprint}|${lib}`;
    const prev = best.get(key);
    if (!prev || r.decidedAt.getTime() > prev.decidedAt.getTime() || (r.decidedAt.getTime() === prev.decidedAt.getTime() && r.libraryVersion > prev.libraryVersion)) best.set(key, r);
  }
  return [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, r]) => {
      const fp = parseDecisionFingerprint(r.fingerprint)!;
      return { code: fp.code, irHash: fp.irHash, canonicalId: r.canonicalId, libraryId: libraryIdOfVersion(r.libraryVersion)! };
    });
}

function decisionFor(decisions: readonly SymbolDecision[], libraryId: string, code: string, irHash: string): SymbolDecision | undefined {
  const c = normaliseCode(code);
  return decisions.find((d) => (d.libraryId === undefined || d.libraryId === libraryId) && normaliseCode(d.code) === c && d.irHash === irHash);
}

/**
 * Whether re-importing the document now would apply exactly the decisions
 * it records: for every fingerprinted source symbol, an applicable
 * decision (an entry the library has, or `null`) ⇔ an `explicit` match
 * with that `canonicalId`. A header without a library (pre-matcher) has
 * nothing to compare and follows trivially; the importer / library check
 * catches it.
 */
export function documentFollowsDecisions(header: HeaderLike & { library?: { id: string } | null }, decisions: readonly SymbolDecision[]): boolean {
  const libraryId = header.library?.id;
  if (!libraryId || !isSymbolLibraryId(libraryId)) return true;
  const entries = new Set(getSymbolLibrary(libraryId).entries.map((e) => e.id));
  const classOf = documentClassOf(header.colours);
  for (const s of header.symbols) {
    if (!isSource(s) || !s.render) continue;
    const d = decisionFor(decisions, libraryId, s.code, symbolIrHash(parseRenderSymbol(s.render), classOf));
    const expected = d && (d.canonicalId === null || entries.has(d.canonicalId)) ? d.canonicalId : undefined;
    const actual = s.match?.method === "explicit" ? s.match.canonicalId : undefined;
    if (expected !== actual) return false;
  }
  return true;
}

// ---- review rows (06 §5.1) ----------------------------------------------------

export type ReviewFlag = "hidden" | "unused" | "club-symbol" | "text";

export interface ReviewCandidate {
  canonicalId: string;
  confidence: number;
  reasons: string[];
}

export interface ReviewRow {
  symbolIdx: number;
  code: string;
  name: string;
  /** The source symbol kind (`rectangle` / `unknown` included, which 06 §5.1 did not list). */
  type: DocumentSymbol["kind"];
  objects: number;
  /** What the document draws: the stored match, `null` before the matcher. */
  match: SymbolMatch | null;
  /** The matcher's own proposal without decisions, best first, ≤ 3 — what `reset` returns to. */
  candidates: ReviewCandidate[];
  colourClass: string;
  flags: ReviewFlag[];
  fingerprint: string | null;
}

export interface ReviewHeaderLike {
  source: { kind: string };
  colours: readonly Pick<DocumentColour, "name" | "cmyk">[];
  mapScale: number;
  documentFactor?: number;
  library?: { id: string } | null;
  symbols: readonly (Omit<DocumentSymbol, "match"> & { match?: SymbolMatch })[];
}

function mainClass(fp: Fingerprint) {
  switch (fp.type) {
    case "line": return fp.mainClass;
    case "area": return fp.fillClass ?? fp.hatchClass ?? fp.patternClass;
    case "point": return fp.dominantClass;
    case "text": return fp.class;
  }
}

const MAX_CANDIDATES = 3;

/**
 * One row per source symbol (graphic and missing-symbol entries are not
 * review items). `objectsPerSymbol[i]` counts the objects of
 * `header.symbols[i]`; `edition` is the one the import used
 * (`report.matching.edition`), detected from the stack when absent.
 */
export function reviewRows(header: ReviewHeaderLike, objectsPerSymbol: readonly number[], opts: { edition?: PaletteEdition } = {}): ReviewRow[] {
  const stored = header.library?.id;
  const libraryId = stored && isSymbolLibraryId(stored) ? stored : chooseLibrary(header.mapScale);
  const edition = opts.edition ?? detectPaletteEdition(header.colours);
  const classOf = documentClassOf(header.colours);
  const ctx = matchContext(libraryId, edition, header.documentFactor ?? 1, classOf);
  const bases = new Set(ctx.canon.map((c) => c.base));
  const canonById = new Map(ctx.canon.map((c) => [c.entry.id, c]));
  const rows: ReviewRow[] = [];
  header.symbols.forEach((s, symbolIdx) => {
    if (!isSource(s)) return;
    const render: RenderSymbol | null = s.render ? parseRenderSymbol(s.render) : null;
    const objects = objectsPerSymbol[symbolIdx] ?? 0;
    const flags: ReviewFlag[] = [];
    if (s.hidden) flags.push("hidden");
    if (objects === 0) flags.push("unused");
    if (!bases.has(baseCode(s.code))) flags.push("club-symbol");
    if (s.kind === "text") flags.push("text");
    const candidates: ReviewCandidate[] = [];
    let colourClass = "unclassified";
    let fingerprint: string | null = null;
    if (render) {
      const fp = fingerprintOf(render, classOf);
      colourClass = formatClass(mainClass(fp));
      fingerprint = decisionFingerprint(header.source.kind, s.code, symbolIrHash(render, classOf));
      // Header matches stay current without a library (pre-matcher) — then no proposal either.
      if (header.library) {
        const proposal = matchSymbol({ code: s.code, name: s.name, render }, ctx).match;
        if (proposal.canonicalId) candidates.push({ canonicalId: proposal.canonicalId, confidence: proposal.confidence, reasons: proposal.reasons });
        for (const alt of proposal.alternatives ?? []) {
          if (candidates.length >= MAX_CANDIDATES) break;
          const cand = canonById.get(alt.canonicalId);
          if (!cand || candidates.some((c) => c.canonicalId === alt.canonicalId)) continue;
          // The same shape as the matcher's own reasons: a head line, then the feature notes.
          const cmp = compareFingerprints(fp, cand.fp, ctx.factor);
          const head = `${alt.canonicalId} ${cmp.hardFail ? "hard fail" : cmp.score.toFixed(2)}${ctx.factor !== 1 ? ` at ×${ctx.factor}` : ""}`;
          candidates.push({ canonicalId: alt.canonicalId, confidence: alt.confidence, reasons: [head, ...cmp.reasons.slice(0, 6)] });
        }
      }
    }
    rows.push({ symbolIdx, code: s.code, name: s.name, type: s.kind, objects, match: s.match ?? null, candidates, colourClass, flags, fingerprint });
  });
  return rows;
}

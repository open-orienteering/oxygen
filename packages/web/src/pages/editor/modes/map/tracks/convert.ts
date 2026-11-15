/**
 * A GPS track converted into a map object, the pure part (docs/map-gps-tracks.md §6; docs/course-editor.md §13 "GPS
 * tracks: convert"; row G26): the trimmed, projected track smoothed (§3.3) and simplified (§3.4) into one line `add`
 * op in document units — exactly the op Map mode's `L` writes for corner nodes (`draw.ts` `drawOp`) —, the change
 * with its symbol's first use, the marks a conversion and its undo write, the controls' ranges and the per-device
 * memory, and the picker's order (the ISSkiOM track group first). No React here.
 */

import { gpsTrack, type mapDocument } from "@oxygen/shared";
import { drawOp } from "../draw";
import type { SymbolPut } from "../symbols";
import { findItem } from "../palette";

type AddOp = Extract<mapDocument.PatchOp, { op: "add" }>;
type PaletteGroup = mapDocument.PaletteGroup;
type PaletteItem = mapDocument.PaletteItem;

// ─── The controls (§6 answer 3) ──

/** Smoothing window, ground metres; 0 is off. */
export const SMOOTH_MIN_M = 0;
export const SMOOTH_MAX_M = 30;
export const SMOOTH_DEFAULT_M = 10;
/** Simplification tolerance, paper mm. */
export const TOL_MIN_MM = 0.02;
export const TOL_MAX_MM = 0.5;
export const TOL_DEFAULT_MM = 0.1;

export interface ConvertSettings {
  windowM: number;
  toleranceMm: number;
}

export const DEFAULT_CONVERT: ConvertSettings = { windowM: SMOOTH_DEFAULT_M, toleranceMm: TOL_DEFAULT_MM };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Settings within the controls' ranges: smoothing whole metres, tolerance to 0.01 mm; anything not finite the default. */
export function clampSettings(s: Partial<ConvertSettings>): ConvertSettings {
  const w = typeof s.windowM === "number" && Number.isFinite(s.windowM) ? Math.round(clamp(s.windowM, SMOOTH_MIN_M, SMOOTH_MAX_M)) : SMOOTH_DEFAULT_M;
  const t = typeof s.toleranceMm === "number" && Number.isFinite(s.toleranceMm)
    ? Math.round(clamp(s.toleranceMm, TOL_MIN_MM, TOL_MAX_MM) * 100) / 100
    : TOL_DEFAULT_MM;
  return { windowM: w, toleranceMm: t };
}

// ─── The line ──

/** The smoothed line (§3.3; a window of 0 leaves the track as projected). */
export function smoothedLine(line: gpsTrack.ProjectedTrack, windowM: number): gpsTrack.ProjectedTrack {
  return windowM > 0 ? gpsTrack.smoothTrack(line, { windowM }) : line;
}

/** The converted polyline: smoothed, then Douglas–Peucker at the tolerance (§3.3–3.4; slice G "smoothed, then DP"). */
export function convertLine(line: gpsTrack.ProjectedTrack, s: ConvertSettings): gpsTrack.ProjectedTrack {
  return gpsTrack.simplifyTrack(smoothedLine(line, s.windowM), s.toleranceMm);
}

/**
 * The line's vertices (paper mm) whose document-unit coordinates differ from the previous one's: two that round to
 * the same unit would be a zero-length segment of the op.
 */
export function lineVertices(line: gpsTrack.ProjectedTrack, unitsPerMm: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let px = NaN, py = NaN;
  for (let i = 0; i < line.x.length; i++) {
    const ux = Math.round(line.x[i] * unitsPerMm), uy = Math.round(line.y[i] * unitsPerMm);
    if (ux === px && uy === py) continue;
    px = ux;
    py = uy;
    out.push({ x: line.x[i], y: line.y[i] });
  }
  return out;
}

/**
 * The `add` of a simplified line (`convertLine`'s output): type 2, corner nodes, the coordinates rounded to whole
 * document units through `drawOp` (as `L` writes them). Null under two distinct coordinates (`geometry-invalid`,
 * map-patches §2.3).
 */
export function lineOp(id: string, simplified: gpsTrack.ProjectedTrack, symbol: mapDocument.PatchSymbolRef, unitsPerMm: number): AddOp | null {
  return drawOp(id, "line", symbol, unitsPerMm, { vertices: lineVertices(simplified, unitsPerMm) });
}

/** One track's op: `convertLine` then `lineOp`. */
export function convertOp(id: string, line: gpsTrack.ProjectedTrack, s: ConvertSettings, symbol: mapDocument.PatchSymbolRef, unitsPerMm: number): AddOp | null {
  return lineOp(id, convertLine(line, s), symbol, unitsPerMm);
}

// ─── A conversion ──

export interface TrackMark {
  id: string;
  opId: string | null;
}

export interface Conversion {
  /** One `add` per converted track, in the tracks' order. */
  ops: AddOp[];
  /** `markConverted` after the write: each converted track → its op (`add:<id>`). */
  marks: TrackMark[];
  /** `markConverted` for the undo: each converted track's mark before (null, or an earlier conversion's op). */
  before: TrackMark[];
  /** Nodes per converted track (a straight polyline: one per coordinate). */
  nodes: { id: string; count: number }[];
  /** Tracks left with fewer than two coordinates: not converted. */
  skipped: string[];
}

export interface ConvertInput {
  id: string;
  convertedOp: string | null;
  /** The simplified line (`convertLine`). */
  simplified: gpsTrack.ProjectedTrack;
}

/** The tracks' ops (one symbol for all, the add id per track from `addIds`), marks and node counts. */
export function planConversion(
  tracks: readonly ConvertInput[], addIds: ReadonlyMap<string, string>, symbol: mapDocument.PatchSymbolRef, unitsPerMm: number,
): Conversion {
  const out: Conversion = { ops: [], marks: [], before: [], nodes: [], skipped: [] };
  for (const t of tracks) {
    const addId = addIds.get(t.id);
    const op = addId ? lineOp(addId, t.simplified, symbol, unitsPerMm) : null;
    if (!op) {
      out.skipped.push(t.id);
      continue;
    }
    out.ops.push(op);
    out.marks.push({ id: t.id, opId: `add:${op.id}` });
    out.before.push({ id: t.id, opId: t.convertedOp });
    out.nodes.push({ id: t.id, count: op.coords.length });
  }
  return out;
}

/** The node count a straight polyline of `simplified` would have (the panel's live count before a symbol is chosen). */
export const nodeCount = (simplified: gpsTrack.ProjectedTrack, unitsPerMm: number): number => {
  const n = lineVertices(simplified, unitsPerMm).length;
  return n >= 2 ? n : 0;
};

/** The one change of a conversion: every `add`, with the symbol's first use (`putSymbols`, map-patches §1.3). */
export function conversionChange(put: Extract<SymbolPut, { ok: true }>, ops: readonly AddOp[]): mapDocument.PatchChange {
  return put.putSymbols ? { put: [...ops], putSymbols: put.putSymbols } : { put: [...ops] };
}

/** Add ids for `trackIds`, ascending in their order (UUIDv7 of consecutive milliseconds; map-patches §2.2 orders by id). */
export function mintAddIds(trackIds: readonly string[], mint: (now: number) => string, now = Date.now()): Map<string, string> {
  return new Map(trackIds.map((id, i) => [id, mint(now + i)]));
}

// ─── Per-device memory (§6 answer 3) ──

/** `localStorage` key of the convert panel's settings and symbol: per device, not per event. */
export const convertStoreKey = "oxygen:gps-track-convert";

/**
 * The remembered symbol: a library entry by its id (any map offers it under that entry, as a library, patch or matched
 * document item), else an unmatched document symbol by its key on the document it was chosen on only.
 */
export type RememberedSymbol = { entry: string } | { key: string; documentHash: string } | null;

export interface StoredConvert extends ConvertSettings {
  symbol: RememberedSymbol;
}

/** The stored settings, clamped; anything unreadable the defaults with no symbol (§6 answer 3: none the first time). */
export function parseStoredConvert(raw: string | null): StoredConvert {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_CONVERT, symbol: null };
  const o = v as Record<string, unknown>;
  const s = clampSettings({ windowM: o.windowM as number, toleranceMm: o.toleranceMm as number });
  const sym = o.symbol as Record<string, unknown> | null | undefined;
  let symbol: RememberedSymbol = null;
  if (sym && typeof sym === "object") {
    if (typeof sym.entry === "string" && sym.entry) symbol = { entry: sym.entry };
    else if (typeof sym.key === "string" && typeof sym.documentHash === "string") symbol = { key: sym.key, documentHash: sym.documentHash };
  }
  return { ...s, symbol };
}

/** What to remember of a picked item. */
export function rememberedOf(item: PaletteItem, documentHash: string): RememberedSymbol {
  if (item.canonicalId) return { entry: item.canonicalId };
  return { key: "doc" in item.ref ? `doc:${item.ref.doc}` : `patch:${item.ref.patch}`, documentHash };
}

const lineItems = (groups: readonly PaletteGroup[]): PaletteItem[] =>
  groups.flatMap((g) => g.headings.flatMap((h) => h.entries.filter((e) => e.kind === "line")));

/** The remembered symbol's enabled line item on this document's palette, else null (nothing is preselected wrongly). */
export function resolveRemembered(groups: readonly PaletteGroup[], s: RememberedSymbol, documentHash: string): PaletteItem | null {
  if (!s) return null;
  if ("entry" in s) return lineItems(groups).find((e) => e.enabled && e.canonicalId === s.entry) ?? null;
  if (s.documentHash !== documentHash) return null;
  const item = findItem(groups, s.key);
  return item && item.enabled && item.kind === "line" ? item : null;
}

// ─── The picker's order ──

/** An ISSkiOM track heading (801–813: the track group of `map-symbols.md` §12). */
const isTrackHeading = (code: string): boolean => /^8(0\d|1[0-3])(\.|$)/.test(code);

/**
 * The palette for a conversion (SLICES G26: "the ISSkiOM track group first"): the ski-O group — the overlay group, or
 * the document's library group on an ISSkiOM map — first, its track headings (801–813) before its other headings;
 * the rest in the palette's order.
 */
export function convertPalette(groups: readonly PaletteGroup[]): PaletteGroup[] {
  const isSki = (g: PaletteGroup) => g.id === "ISSkiOM2019" || g.library === "ISSkiOM2019";
  const ski = groups.filter(isSki).map((g) => ({
    ...g,
    headings: [...g.headings.filter((h) => isTrackHeading(h.code)), ...g.headings.filter((h) => !isTrackHeading(h.code))],
  }));
  return [...ski, ...groups.filter((g) => !isSki(g))];
}

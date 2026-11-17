/**
 * A GPS track converted into a map object, the pure part (docs/map-gps-tracks.md §6; docs/course-editor.md §13 "GPS
 * tracks: convert"; row G26): the trimmed, projected track smoothed (§3.3) and simplified (§3.4) into one line `add`
 * op in document units — exactly the op Map mode's `L` writes for corner nodes (`draw.ts` `drawOp`) —, the change
 * with its symbol's first use, the marks a conversion and its undo write, the controls' ranges and the per-device
 * memory, and the picker's order (the ISSkiOM track group first). No React here.
 */

import { gpsTrack, type mapDocument } from "@oxygen/shared";
import { nearestOnLines, nearestOnPath, type LineHit } from "../../../../../lib/editor/snap";
import { drawOp } from "../draw";
import type { SymbolPut } from "../symbols";
import { findItem } from "../palette";
import { SNAP_ENDS_MM, isTrackSymbolRef, snapLineEnds } from "./snap-ends";

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
  /** `markConverted` after the write: each converted track → its op (`add:<id>`), and an average's sources (G27). */
  marks: TrackMark[];
  /** `markConverted` for the undo: each marked track's mark before (null, or an earlier conversion's op). */
  before: TrackMark[];
  /** Nodes per converted track (a straight polyline: one per coordinate). */
  nodes: { id: string; count: number }[];
  /** Tracks left with fewer than two coordinates: not converted. */
  skipped: string[];
  /** Ends moved by the end snap (§6.7), over every op; 0 without it. */
  snapped: number;
}

/**
 * The end snap of a conversion (§6.7; row G28): the effective document and its track-symbol filter
 * (`trackSymbolFilter`). The batch's earlier lines are targets when the conversion's symbol is a track symbol.
 */
export interface ConvertSnap {
  doc: Parameters<typeof nearestOnLines>[0] & Pick<mapDocument.EffectiveDocument, "patch">;
  filter: (symbolIdx: number) => boolean;
}

export interface ConvertInput {
  id: string;
  convertedOp: string | null;
  /** The simplified line (`convertLine`). */
  simplified: gpsTrack.ProjectedTrack;
  /** An average's sources still listed, with their marks: marked with its op too (§5.2, user 2026-11-15). */
  sources?: readonly { id: string; convertedOp: string | null }[];
}

/**
 * The nearest target of an end (paper mm) within `SNAP_ENDS_MM`: a track line of the document, else of the batch's
 * earlier `lines` (document units) — the document's on a tie, then the earlier line's.
 */
function nearestTarget(snap: ConvertSnap, lines: readonly (readonly mapDocument.PatchCoord[])[], unitsPerMm: number, pt: { x: number; y: number }): LineHit | null {
  let best = nearestOnLines(snap.doc, pt, SNAP_ENDS_MM, snap.filter);
  for (const coords of lines) {
    const hit = nearestOnPath(coords, unitsPerMm, pt, SNAP_ENDS_MM);
    if (hit && (!best || hit.distanceMm < best.distanceMm)) best = hit;
  }
  return best;
}

/**
 * The tracks' ops (one symbol for all, the add id per track from `addIds`), marks and node counts. An average's
 * sources take its op (§5.2), so one `markConverted` never names an id twice (§1.2): a track converted in the same
 * batch keeps its own op, a source of two averages the later one's; `before` is each id's mark before the batch.
 *
 * With `snap` (§6.7), each op's ends are snapped in list order, each seeing the document's track lines and — when
 * `symbol` is a track symbol — the lines already made in the batch (§6 answer 5). The op's coordinates are then the
 * snapped ones; nothing else changes.
 */
export function planConversion(
  tracks: readonly ConvertInput[], addIds: ReadonlyMap<string, string>, symbol: mapDocument.PatchSymbolRef, unitsPerMm: number,
  snap: ConvertSnap | null = null,
): Conversion {
  const out: Conversion = { ops: [], marks: [], before: [], nodes: [], skipped: [], snapped: 0 };
  const marks = new Map<string, string>(), before = new Map<string, string | null>();
  const converted: { t: ConvertInput; opId: string }[] = [];
  const batchTargets = !!snap && isTrackSymbolRef(snap.doc, symbol);
  for (const t of tracks) {
    const addId = addIds.get(t.id);
    let op = addId ? lineOp(addId, t.simplified, symbol, unitsPerMm) : null;
    if (op && snap) {
      const lines = batchTargets ? out.ops.map((o) => o.coords) : [];
      const r = snapLineEnds(op.coords, (pt) => nearestTarget(snap, lines, unitsPerMm, pt), unitsPerMm);
      if (r.snapped > 0) {
        op = { ...op, coords: r.coords };
        out.snapped += r.snapped;
      }
    }
    if (!op) {
      out.skipped.push(t.id);
      continue;
    }
    out.ops.push(op);
    marks.set(t.id, `add:${op.id}`);
    before.set(t.id, t.convertedOp);
    converted.push({ t, opId: `add:${op.id}` });
    out.nodes.push({ id: t.id, count: op.coords.length });
  }
  const own = new Set(marks.keys());
  for (const { t, opId } of converted) {
    for (const s of t.sources ?? []) {
      if (own.has(s.id)) continue;
      marks.set(s.id, opId);
      if (!before.has(s.id)) before.set(s.id, s.convertedOp);
    }
  }
  out.marks = [...marks].map(([id, opId]) => ({ id, opId }));
  out.before = [...before].map(([id, opId]) => ({ id, opId }));
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
 * The remembered symbol: the item's key (`doc:<i>` / `patch:<key>`) on the document it was chosen on, and its library
 * entry when it has one (the item's `canonicalId`) for any other map.
 */
export type RememberedSymbol = { key: string; documentHash: string; entry: string | null } | null;

export interface StoredConvert extends ConvertSettings {
  symbol: RememberedSymbol;
  /** *Snap ends* (§6.7): on unless turned off on this device. */
  snapEnds: boolean;
}

/** The stored settings, clamped; anything unreadable the defaults with no symbol (§6 answer 3: none the first time). */
export function parseStoredConvert(raw: string | null): StoredConvert {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_CONVERT, symbol: null, snapEnds: true };
  const o = v as Record<string, unknown>;
  const s = clampSettings({ windowM: o.windowM as number, toleranceMm: o.toleranceMm as number });
  const sym = o.symbol as Record<string, unknown> | null | undefined;
  const symbol: RememberedSymbol = sym && typeof sym === "object" && typeof sym.key === "string" && typeof sym.documentHash === "string"
    ? { key: sym.key, documentHash: sym.documentHash, entry: typeof sym.entry === "string" && sym.entry ? sym.entry : null }
    : null;
  return { ...s, symbol, snapEnds: o.snapEnds !== false };
}

/** What to remember of a picked item. */
export function rememberedOf(item: PaletteItem, documentHash: string): RememberedSymbol {
  return { key: "doc" in item.ref ? `doc:${item.ref.doc}` : `patch:${item.ref.patch}`, documentHash, entry: item.canonicalId };
}

const lineItems = (groups: readonly PaletteGroup[]): PaletteItem[] =>
  groups.flatMap((g) => g.headings.flatMap((h) => h.entries.filter((e) => e.kind === "line")));

/**
 * The remembered symbol's enabled line item on this document's palette: on its own document the item it was (by
 * key), elsewhere the first item offering its library entry; else null — a symbol of another document's own table is
 * never taken for this one's.
 */
export function resolveRemembered(groups: readonly PaletteGroup[], s: RememberedSymbol, documentHash: string): PaletteItem | null {
  if (!s) return null;
  const usable = (item: PaletteItem | null | undefined) => (item && item.enabled && item.kind === "line" ? item : null);
  if (s.documentHash === documentHash) {
    const own = usable(findItem(groups, s.key));
    if (own) return own;
  }
  return s.entry ? usable(lineItems(groups).find((e) => e.enabled && e.canonicalId === s.entry)) : null;
}

/** The panel's node count: the total, the largest track's, and whether one is over `max` (§6 answer 2). */
export function nodeSummary(nodes: readonly { count: number }[], max: number): { total: number; largest: number; over: boolean } {
  let total = 0, largest = 0;
  for (const n of nodes) {
    total += n.count;
    if (n.count > largest) largest = n.count;
  }
  return { total, largest, over: largest > max };
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

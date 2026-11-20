/**
 * Map mode's GPS tracks, the pure part (docs/map-gps-tracks.md §5.1; docs/course-editor.md §13 "GPS tracks"; row G25):
 * where the panel is off, an import planned from the files' text (parsed on the device, chunked to the API's caps),
 * a stored track projected onto the pinned document, the list's rows, the colour, locate's bounds, the per-device
 * visibility overrides over a default that hides converted tracks unless *Show converted* (G26, §6 answer 1) and an
 * average's passes (G27, §5.2), the conversion's track selection, and a deleted track's re-import (its undo).
 */

import { gpsTrack, type mapGeo } from "@oxygen/shared";
import type { TrackImportItem, TrackMeta } from "../../../../../lib/editor/write-client";

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** The API's caps (§1.2 "Caps"). */
export const MAX_TRACK_POINTS = 200_000;
export const MAX_CALL_POINTS = 500_000;
export const MAX_CALL_TRACKS = 200;
const MAX_NAME = 200;
const MAX_SOURCE_NAME = 255;

// ─── Where it is off ──

export type TracksDisabled = "venue" | "no-permission" | "not-georeferenced";

/** §5.1 "Where it is off", in that order; `nodeRole` undefined while `lease.status` loads. */
export function disabledReason(a: { nodeRole: string | undefined; canEdit: boolean; georeferenced: boolean }): TracksDisabled | null {
  if (a.nodeRole === "venue") return "venue";
  if (!a.canEdit) return "no-permission";
  if (!a.georeferenced) return "not-georeferenced";
  return null;
}

// ─── Import ──

export interface ImportIssue {
  file: string;
  /** The track's name for a refused track (`too-many-points`); absent for a file that did not parse. */
  track?: string | null;
  /** A `GpxParseError` code, `too-many-points`, or the server's `TRACK_*` code. */
  code: string;
}

export interface ImportPlan {
  /** The calls to send, in file order (§1.2 "Caps"). */
  calls: TrackImportItem[][];
  /** Tracks in `calls`. */
  tracks: number;
  issues: ImportIssue[];
  /** What the files had that is not imported (§2.2). */
  skipped: { points: number; segments: number; waypoints: number };
}

/** Tracks into calls of at most 200 tracks and 500 000 points, in order. */
export function chunkTracks(items: TrackImportItem[]): TrackImportItem[][] {
  const calls: TrackImportItem[][] = [];
  let call: TrackImportItem[] = [];
  let points = 0;
  for (const item of items) {
    const n = item.points.lat.length;
    if (call.length > 0 && (call.length >= MAX_CALL_TRACKS || points + n > MAX_CALL_POINTS)) {
      calls.push(call);
      call = [];
      points = 0;
    }
    call.push(item);
    points += n;
  }
  if (call.length > 0) calls.push(call);
  return calls;
}

/** The files' text parsed (`parseTrackFile`: GPX or TCX, §2) into the import's calls; a file that does not parse is an issue, the rest go. */
export function planImport(files: readonly { name: string; text: string }[]): ImportPlan {
  const items: TrackImportItem[] = [];
  const issues: ImportIssue[] = [];
  const skipped = { points: 0, segments: 0, waypoints: 0 };
  for (const f of files) {
    let parsed: gpsTrack.GpxFile;
    try {
      parsed = gpsTrack.parseTrackFile(f.text);
    } catch (e) {
      issues.push({ file: f.name, code: e instanceof gpsTrack.GpxParseError ? e.code : "malformed" });
      continue;
    }
    skipped.points += parsed.skippedPoints;
    skipped.segments += parsed.skippedSegments;
    skipped.waypoints += parsed.waypoints;
    for (const t of parsed.tracks) {
      if (t.points.lat.length > MAX_TRACK_POINTS) {
        issues.push({ file: f.name, track: t.name, code: "too-many-points" });
        continue;
      }
      items.push({ name: t.name === null ? null : t.name.slice(0, MAX_NAME), sourceName: f.name.slice(0, MAX_SOURCE_NAME), points: t.points });
    }
  }
  return { calls: chunkTracks(items), tracks: items.length, issues, skipped };
}

/** A refused write's `TRACK_*` code (the message prefix, §1.2), else null. */
export function trackErrorCode(e: unknown): string | null {
  const message = e instanceof Error ? e.message : String(e);
  return /^(TRACK_[A-Z_]+)/.exec(message)?.[1] ?? null;
}

// ─── Projection and rows ──

export interface TrackGeometry {
  /** The trimmed range on the paper (index `i` is stored point `trim.start + i`). */
  line: gpsTrack.ProjectedTrack;
  /** Ground metres along it (§1.1). */
  lengthM: number;
  /** Its points outside the map (§3.2). */
  outside: number;
  /** Paper mm. */
  bbox: Bounds;
}

/** §5.1 "Projection": the trimmed track onto the frame; a `TrackProjectionError` is the row's error. */
export function projectTrackRow(frame: mapGeo.PaperFrame, bounds: Bounds, trim: gpsTrack.TrackRange, points: gpsTrack.TrackPoints): TrackGeometry | { error: string } {
  let projected: gpsTrack.ProjectedResult;
  try {
    projected = gpsTrack.projectTrack(frame, gpsTrack.trimTrack({ name: null, points }, trim), bounds);
  } catch (e) {
    return { error: e instanceof gpsTrack.TrackProjectionError ? e.code : "not-projectable" };
  }
  const { x, y, metresPerMm } = projected.track;
  let mm = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (i > 0) {
      const dx = x[i] - x[i - 1], dy = y[i] - y[i - 1];
      mm += Math.sqrt(dx * dx + dy * dy);
    }
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  return { line: projected.track, lengthM: mm * metresPerMm, outside: projected.outside, bbox: { minX, minY, maxX, maxY } };
}

export interface TrackRow {
  meta: TrackMeta;
  /** The name, else the file name. */
  label: string;
  colour: string;
  visible: boolean;
  state: "loading" | "ready" | "error";
  geometry: TrackGeometry | null;
  error: string | null;
  /** Points of the trimmed range. */
  points: number;
  /** A listed average names it in `derivedFrom` (G27): hidden by default. */
  isSource: boolean;
  /** An average's sources still listed, with their marks (G27: a conversion marks them too, §5.2). */
  sources: { id: string; convertedOp: string | null }[];
}

/** The ids a listed track names in its `derivedFrom` (an average's passes, §4; listed or not). */
export function sourceIds(metas: readonly Pick<TrackMeta, "derivedFrom">[]): Set<string> {
  const out = new Set<string>();
  for (const m of metas) for (const id of m.derivedFrom) out.add(id);
  return out;
}

/**
 * The list's rows in `mapTrack.list` order; `geometry` per id (absent: still loading). Shown is the device's override,
 * else the default (`defaultVisible`; an average's passes are sources, G27).
 */
export function trackRows(
  metas: readonly TrackMeta[],
  geometry: ReadonlyMap<string, TrackGeometry | { error: string }>,
  overrides: Readonly<Record<string, boolean>>,
  showConverted = false,
): TrackRow[] {
  const sources = sourceIds(metas);
  const byId = new Map(metas.map((m) => [m.id, m]));
  return metas.map((meta) => {
    const g = geometry.get(meta.id);
    const error = g && "error" in g ? g.error : null;
    const isSource = sources.has(meta.id);
    return {
      meta,
      label: meta.name ?? (meta.sourceName || meta.id),
      colour: trackColour(meta.id),
      visible: overrides[meta.id] ?? defaultVisible(meta, showConverted, isSource),
      state: !g ? "loading" : error ? "error" : "ready",
      geometry: g && !("error" in g) ? g : null,
      error,
      points: meta.trim.end - meta.trim.start,
      isSource,
      sources: meta.derivedFrom.flatMap((id) => {
        const s = id === meta.id ? undefined : byId.get(id);
        return s ? [{ id, convertedOp: s.convertedOp }] : [];
      }),
    };
  });
}

// ─── Colour, locate, visibility ──

/** Eight track colours: clear of the overprint purple of the UI's handles and of black / brown / green map ink. */
export const TRACK_COLOURS = ["#e11d48", "#2563eb", "#ea580c", "#0891b2", "#ca8a04", "#4f46e5", "#0d9488", "#be185d"] as const;

/** A colour by a hash (FNV-1a) of the id: stable on every device, not stored (§5.1, user 2026-11-15). */
export function trackColour(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return TRACK_COLOURS[h % TRACK_COLOURS.length];
}

/** §5.1 "Locate": the track's box padded by 5 %, each side at least 10 mm. */
export function locateBounds(b: Bounds): Bounds {
  const grow = (lo: number, hi: number): [number, number] => {
    const pad = (hi - lo) * 0.05;
    let a = lo - pad, z = hi + pad;
    if (z - a < 10) {
      const c = (lo + hi) / 2;
      a = c - 5;
      z = c + 5;
    }
    return [a, z];
  };
  const [minX, maxX] = grow(b.minX, b.maxX), [minY, maxY] = grow(b.minY, b.maxY);
  return { minX, minY, maxX, maxY };
}

/** `localStorage` key of an event's overrides. */
export const visibilityKey = (nameId: string): string => `oxygen:gps-tracks:${nameId}`;

/** Stored overrides `{ [id]: shown }`; anything else is none. */
export function parseVisibility(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
  } catch {
    return {};
  }
}

/**
 * A track's default visibility (§5.1 "Show / hide"; §6 answer 1): shown, except a converted one — hidden until the
 * conversion is undone, unless *Show converted* is on — and a listed average's pass (`isSource`, G27), hidden while
 * the average is listed, *Show converted* or not.
 */
export const defaultVisible = (meta: Pick<TrackMeta, "convertedOp">, showConverted: boolean, isSource = false): boolean =>
  !isSource && (!meta.convertedOp || showConverted);

/** The overrides after the eye set `visible`: an override is kept only where it differs from the default. */
export function nextOverrides(
  overrides: Readonly<Record<string, boolean>>, meta: Pick<TrackMeta, "id" | "convertedOp">, visible: boolean, showConverted: boolean, isSource = false,
): Record<string, boolean> {
  const next = { ...overrides };
  if (visible === defaultVisible(meta, showConverted, isSource)) delete next[meta.id];
  else next[meta.id] = visible;
  return next;
}

/** `localStorage` key of an event's *Show converted* (per device, beside the overrides; `pruneVisibility` keeps ids only). */
export const showConvertedKey = (nameId: string): string => `oxygen:gps-tracks:${nameId}:show-converted`;

/** The conversion's selection kept to rows that are listed and ready (projected), in list order. */
export function pruneSelection(selected: readonly string[], rows: readonly Pick<TrackRow, "meta" | "state">[]): string[] {
  const keep = new Set(selected);
  return rows.filter((r) => r.state === "ready" && keep.has(r.meta.id)).map((r) => r.meta.id);
}

/** Overrides of ids still listed. */
export function pruneVisibility(overrides: Readonly<Record<string, boolean>>, ids: readonly string[]): Record<string, boolean> {
  const keep = new Set(ids);
  return Object.fromEntries(Object.entries(overrides).filter(([id]) => keep.has(id)));
}

// ─── Undo ──

/** A deleted track's re-import under its id (§1.2: an undo re-imports a removed track); trim and `convertedOp` follow by `update` / `markConverted`. */
export function deletedTrackImport(meta: TrackMeta, points: gpsTrack.TrackPoints): TrackImportItem {
  const item: TrackImportItem = { id: meta.id, name: meta.name, sourceName: meta.sourceName, points };
  if (meta.derivedFrom.length > 0 && meta.singlePass) {
    item.derivedFrom = meta.derivedFrom;
    item.singlePass = meta.singlePass;
  }
  return item;
}

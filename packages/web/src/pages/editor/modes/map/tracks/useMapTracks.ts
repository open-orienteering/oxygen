/**
 * Map mode's GPS tracks (docs/map-gps-tracks.md §5.1; docs/course-editor.md §13 "GPS tracks"; row G25): the event's
 * tracks listed (`mapTrack.list`), their points fetched one track at a time and projected onto the pinned document,
 * the reference layer decimated to the zoom the pointer last reported, and the writes — import, rename, delete, each
 * one undo entry. Off, with the reason and no `mapTrack` request, on a venue node, without `courses.edit`, or on a
 * map without a georeference. For G26's conversion: the tracks selected to convert, *Show converted*, and the marks a
 * conversion and its undo write (`mark`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { gpsTrack, type mapGeo } from "@oxygen/shared";
import { trpc } from "../../../../../lib/trpc";
import type { LoadedMapDocument } from "../../../../../lib/map-document-cache";
import type { EditorWrites, TrackImportItem, TrackMeta } from "../../../../../lib/editor/write-client";
import { paperFrameOf } from "../../../../../lib/vector-map";
import type { TrackLayer } from "../../../tools/bindings";
import { DEFAULT_TOLERANCE_MM, decimateLayer, layerShapes, toleranceMm } from "./decimate";
import {
  chunkTracks, deletedTrackImport, disabledReason, locateBounds, nextOverrides, parseVisibility, planImport, projectTrackRow, pruneSelection, pruneVisibility,
  showConvertedKey, trackErrorCode, trackRows, visibilityKey, type ImportIssue, type TrackGeometry, type TrackRow, type TracksDisabled,
} from "./model";

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export interface MapTracksArgs {
  /** Map mode is on. */
  enabled: boolean;
  nameId: string;
  mapDoc: LoadedMapDocument | null;
  canEdit: boolean;
  writes: EditorWrites;
  run: <T>(op: () => Promise<T>) => Promise<T | undefined>;
  record: (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;
  /** Fit the view to these paper-mm bounds (Map mode's `viewRequest`). */
  onLocate: (bounds: Bounds) => void;
}

export interface ImportResult {
  imported: number;
  issues: ImportIssue[];
  skipped: { points: number; segments: number; waypoints: number };
}

export interface MapTracks {
  /** The reference layer for `withTrackLayer`. */
  layer: TrackLayer;
  /** The rows selected to convert (listed and ready, list order; session only). */
  selection: TrackRow[];
  clearSelection: () => void;
  /** `mapTrack.markConverted` for the tracks still listed (G26: a conversion, its undo and redo); nothing when none is. */
  mark: (marks: readonly { id: string; opId: string | null }[]) => Promise<void>;
  /** Null without a pinned document (Map mode's own `editor-map-none` stands). */
  panel: {
    disabled: TracksDisabled | null;
    loading: boolean;
    rows: TrackRow[];
    importing: boolean;
    result: ImportResult | null;
    onImport: (files: readonly File[]) => void;
    onVisible: (id: string, visible: boolean) => void;
    /** The conversion's selection (G26). */
    selected: ReadonlySet<string>;
    onSelect: (id: string, on: boolean) => void;
    /** *Show converted* (per device and event, G26): converted tracks without an override are drawn. */
    showConverted: boolean;
    onShowConverted: (on: boolean) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    onLocate: (id: string) => void;
  } | null;
}

/** A refused track write's message, translated by its `TRACK_*` code (§1.2), else as it came. */
function trackErrorText(e: unknown, t: TFunction<"editor">): string {
  const code = trackErrorCode(e);
  if (code) {
    const text = t(`trackError_${code}`, { defaultValue: "" });
    if (text) return text;
  }
  if (e instanceof Error && /connectivity/i.test(e.message)) return t("trackError_offline");
  return e instanceof Error ? e.message : String(e);
}

const EMPTY: readonly TrackMeta[] = [];

/** Projections per frame, points and trim: a re-render, a newly loaded track or a visibility change projects nothing again. */
const projections = new WeakMap<object, WeakMap<gpsTrack.TrackPoints, Map<string, TrackGeometry | { error: string }>>>();

function projected(frame: mapGeo.PaperFrame, bounds: Bounds, trim: gpsTrack.TrackRange, points: gpsTrack.TrackPoints): TrackGeometry | { error: string } {
  let byPoints = projections.get(frame);
  if (!byPoints) projections.set(frame, (byPoints = new WeakMap()));
  let byTrim = byPoints.get(points);
  if (!byTrim) byPoints.set(points, (byTrim = new Map()));
  const key = `${trim.start}|${trim.end}`;
  let g = byTrim.get(key);
  if (!g) byTrim.set(key, (g = projectTrackRow(frame, bounds, trim, points)));
  return g;
}

function readOverrides(nameId: string): Record<string, boolean> {
  try {
    return parseVisibility(localStorage.getItem(visibilityKey(nameId)));
  } catch {
    return {};
  }
}

function readShowConverted(nameId: string): boolean {
  try {
    return localStorage.getItem(showConvertedKey(nameId)) === "1";
  } catch {
    return false;
  }
}

export function useMapTracks(a: MapTracksArgs): MapTracks {
  const { t } = useTranslation("editor");
  const utils = trpc.useUtils();
  const { enabled, nameId, mapDoc, canEdit, writes, run, record, onLocate } = a;

  // ─── Where it is off (§5.1) ──
  const lease = trpc.lease.status.useQuery(undefined, { enabled: enabled && !!mapDoc, staleTime: 60_000, refetchOnWindowFocus: false });
  const metadata = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY, enabled: enabled && !!mapDoc });
  const rotationCorrection = metadata.data?.rotationCorrection;
  const frame = useMemo(() => (mapDoc ? paperFrameOf(mapDoc.header, rotationCorrection) : null), [mapDoc, rotationCorrection]);
  const disabled = disabledReason({ nodeRole: lease.data?.nodeRole, canEdit, georeferenced: !!frame && gpsTrack.isGeoreferenced(frame) });
  // The node's role must be known before the first request (a venue makes none); a failed status is not a venue.
  const active = enabled && !!mapDoc && (lease.isSuccess || lease.isError) && disabled === null;

  // ─── The list and the points ──
  const list = trpc.mapTrack.list.useQuery(undefined, { enabled: active, refetchOnWindowFocus: false });
  const metas = (active ? list.data?.tracks : undefined) ?? EMPTY;
  // Points never change under one id (§1.2): kept for the session, fetched one `get` at a time (a capped track is
  // megabytes, §5.1); an import's own points go in directly.
  // A failed `get` is retried once the list is fetched again (`failed` holds the list's fetch time it failed under).
  const [loaded, setLoaded] = useState<{ points: ReadonlyMap<string, gpsTrack.TrackPoints>; failed: ReadonlyMap<string, number> }>(
    () => ({ points: new Map(), failed: new Map() }),
  );
  const listedAt = list.dataUpdatedAt;
  const failedNow = useCallback((id: string) => (loaded.failed.get(id) ?? -1) >= listedAt, [loaded, listedAt]);
  const addPoints = useCallback((entries: readonly [string, gpsTrack.TrackPoints][]) => {
    setLoaded((l) => ({ ...l, points: new Map([...l.points, ...entries]) }));
  }, []);
  const loading = useRef(false);
  useEffect(() => {
    if (!active || loading.current) return;
    const missing = metas.filter((m) => !loaded.points.has(m.id) && !failedNow(m.id));
    if (missing.length === 0) return;
    loading.current = true;
    void (async () => {
      try {
        for (const m of missing) {
          try {
            const res = await utils.client.mapTrack.get.query({ id: m.id });
            addPoints([[m.id, res.points]]);
          } catch {
            setLoaded((l) => ({ ...l, failed: new Map([...l.failed, [m.id, listedAt]]) }));
          }
        }
      } finally {
        // The next run picks up what was listed meanwhile.
        loading.current = false;
        setLoaded((l) => ({ ...l }));
      }
    })();
  }, [active, metas, loaded, utils, addPoints, failedNow, listedAt]);

  // ─── Projection, per track and trim, again when the frame changes ──
  const geometry = useMemo(() => {
    const out = new Map<string, TrackGeometry | { error: string }>();
    if (!frame || !mapDoc) return out;
    for (const m of metas) {
      const p = loaded.points.get(m.id);
      if (p) out.set(m.id, projected(frame, mapDoc.header.bounds, m.trim, p));
      else if (failedNow(m.id)) out.set(m.id, { error: "load-failed" });
    }
    return out;
  }, [frame, mapDoc, metas, loaded, failedNow]);

  // ─── Show / hide, per device (user 2026-11-15) ──
  const [saved, setSaved] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `saved` re-reads the store after a write
  const overrides = useMemo(() => readOverrides(nameId), [nameId, saved]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  const showConverted = useMemo(() => readShowConverted(nameId), [nameId, saved]);
  const onShowConverted = useCallback((on: boolean) => {
    try {
      if (on) localStorage.setItem(showConvertedKey(nameId), "1");
      else localStorage.removeItem(showConvertedKey(nameId));
    } catch {
      // Storage refused: not kept.
    }
    setSaved((n) => n + 1);
  }, [nameId]);
  /** Writes the overrides of ids still listed (§5.1: ids no longer listed are dropped). */
  const saveOverrides = useCallback((next: Record<string, boolean>) => {
    const pruned = pruneVisibility(next, metas.map((m) => m.id));
    try {
      if (Object.keys(pruned).length === 0) localStorage.removeItem(visibilityKey(nameId));
      else localStorage.setItem(visibilityKey(nameId), JSON.stringify(pruned));
    } catch {
      // Storage refused (a private window): the choice is not kept.
    }
    setSaved((n) => n + 1);
  }, [nameId, metas]);

  const rows = useMemo(() => trackRows(metas, geometry, overrides, showConverted), [metas, geometry, overrides, showConverted]);

  // ─── The conversion's selection (G26), session only ──
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const selectionIds = useMemo(() => pruneSelection(selectedIds, rows), [selectedIds, rows]);
  const selection = useMemo(() => {
    const keep = new Set(selectionIds);
    return rows.filter((r) => keep.has(r.meta.id));
  }, [rows, selectionIds]);
  const selectedSet = useMemo(() => new Set(selectionIds), [selectionIds]);
  const onSelect = useCallback((id: string, on: boolean) => setSelectedIds((s) => (on ? [...s.filter((x) => x !== id), id] : s.filter((x) => x !== id))), []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);
  useEffect(() => { if (!enabled) setSelectedIds([]); }, [enabled, nameId]);

  // ─── The layer, decimated to the pixel ──
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE_MM);
  const onScale = useCallback((mmPerPx: number) => setTolerance(toleranceMm(mmPerPx)), []);
  const shapes = useMemo(() => {
    if (!active) return [];
    const lines = rows.flatMap((r) => (r.visible && r.geometry ? [{ id: r.meta.id, colour: r.colour, line: r.geometry.line }] : []));
    return lines.length > 0 ? layerShapes(decimateLayer(lines, tolerance)) : [];
  }, [active, rows, tolerance]);
  const layer = useMemo<TrackLayer>(() => ({ shapes, onScale }), [shapes, onScale]);

  // ─── Writes ──
  const refresh = useCallback(() => utils.mapTrack.list.invalidate(), [utils]);
  /** A write whose refusal shows translated; the list reloads either way. */
  const send = useCallback(async <T,>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (e) {
      throw new Error(trackErrorText(e, t), { cause: e });
    } finally {
      void refresh();
    }
  }, [t, refresh]);
  const importItems = useCallback(async (items: TrackImportItem[]): Promise<TrackMeta[]> => {
    const out: TrackMeta[] = [];
    for (const call of chunkTracks(items)) out.push(...(await writes.importTracks(call)).tracks);
    return out;
  }, [writes]);
  const removeIds = useCallback(async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 200) await writes.removeTracks(ids.slice(i, i + 200));
  }, [writes]);

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const onImport = useCallback((files: readonly File[]) => {
    if (!active || files.length === 0) return;
    setImporting(true);
    setResult(null);
    void run(async () => {
      try {
        const texts = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
        const plan = planImport(texts);
        const issues = [...plan.issues];
        const done: { item: TrackImportItem; meta: TrackMeta }[] = [];
        // Call by call, in file order; a refused call stops the import there and the calls before it stay (§5.1).
        for (const call of plan.calls) {
          try {
            const res = await writes.importTracks(call);
            res.tracks.forEach((meta, i) => {
              done.push({ item: { ...call[i], id: meta.id }, meta });
            });
            addPoints(res.tracks.map((meta, i) => [meta.id, call[i].points]));
          } catch (e) {
            issues.push({ file: call[0].sourceName, code: trackErrorCode(e) ?? "failed" });
            break;
          }
        }
        setResult({ imported: done.length, issues, skipped: plan.skipped });
        if (done.length > 0) {
          const ids = done.map((d) => d.meta.id), items = done.map((d) => d.item);
          record(() => send(() => removeIds(ids)), () => send(() => importItems(items)));
        }
      } finally {
        setImporting(false);
        void refresh();
      }
    });
  }, [active, run, writes, record, send, removeIds, importItems, refresh, addPoints]);

  const metaOf = useCallback((id: string) => metas.find((m) => m.id === id) ?? null, [metas]);
  const onRename = useCallback((id: string, name: string) => {
    const meta = metaOf(id);
    const next = name.trim().slice(0, 200) || null;
    if (!meta || next === meta.name) return;
    const before = meta.name;
    void run(async () => {
      await send(() => writes.updateTrack({ id, name: next }));
      record(() => send(() => writes.updateTrack({ id, name: before })), () => send(() => writes.updateTrack({ id, name: next })));
    });
  }, [metaOf, run, send, writes, record]);

  const onDelete = useCallback((id: string) => {
    const meta = metaOf(id);
    if (!meta) return;
    void run(async () => {
      // The undo re-imports the track under its id, so its points must be in hand first.
      let p = loaded.points.get(id);
      if (!p) {
        p = (await send(() => utils.client.mapTrack.get.query({ id }))).points;
        addPoints([[id, p]]);
      }
      const item = deletedTrackImport(meta, p);
      await send(() => writes.removeTracks([id]));
      const full = meta.trim.start === 0 && meta.trim.end === meta.pointCount;
      record(
        () => send(async () => {
          await writes.importTracks([item]);
          if (!full) await writes.updateTrack({ id, trim: meta.trim });
          if (meta.convertedOp) await writes.markTracksConverted([{ id, opId: meta.convertedOp }]);
        }),
        () => send(() => writes.removeTracks([id])),
      );
    });
  }, [metaOf, run, send, writes, record, utils, loaded, addPoints]);

  const onVisible = useCallback((id: string, visible: boolean) => {
    const meta = metaOf(id);
    if (meta) saveOverrides(nextOverrides(overrides, meta, visible, showConverted)); // kept only where it differs from the default
  }, [metaOf, overrides, saveOverrides, showConverted]);

  // The marks go to tracks still listed: one deleted meanwhile (here or elsewhere) is skipped, not a failed undo.
  const metasRef = useRef(metas);
  metasRef.current = metas;
  const mark = useCallback(async (marks: readonly { id: string; opId: string | null }[]) => {
    const listed = new Set(metasRef.current.map((m) => m.id));
    const keep = marks.filter((m) => listed.has(m.id));
    if (keep.length > 0) await send(() => writes.markTracksConverted(keep));
  }, [send, writes]);

  const onLocateTrack = useCallback((id: string) => {
    const g = geometry.get(id);
    if (g && "bbox" in g) onLocate(locateBounds(g.bbox));
  }, [geometry, onLocate]);

  const panel = !mapDoc ? null : {
    disabled,
    // Until the node's role is known nothing is offered (a venue box shows its reason, never an import).
    loading: disabled === null && (!(lease.isSuccess || lease.isError) || list.isLoading),
    rows,
    importing,
    result,
    onImport,
    onVisible,
    selected: selectedSet,
    onSelect,
    showConverted,
    onShowConverted,
    onRename,
    onDelete,
    onLocate: onLocateTrack,
  };
  return { layer, selection, clearSelection, mark, panel };
}

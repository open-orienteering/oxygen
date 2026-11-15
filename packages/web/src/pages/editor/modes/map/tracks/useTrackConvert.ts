/**
 * The convert panel's state (docs/map-gps-tracks.md §6; docs/course-editor.md §13 "GPS tracks: convert"; row G26):
 * the selected tracks smoothed and simplified at the controls' values, the symbol picked from the palette (ski-O
 * track group first), the live node count, the preview ops, and the change and marks *Convert* writes. Settings and
 * the symbol are remembered on the device; nothing is chosen the first time. The write itself is Map mode's
 * (`commit`, one undo entry); this hook only plans it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gpsTrack, mapDocument } from "@oxygen/shared";
import { findItem, itemKey } from "../palette";
import { newAddId, symbolPut, type SymbolPut } from "../symbols";
import { MAP_NODES_MAX } from "../nodes";
import type { TrackRow } from "./model";
import {
  clampSettings, conversionChange, convertPalette, convertStoreKey, mintAddIds, nodeCount, parseStoredConvert, planConversion, rememberedOf, resolveRemembered,
  smoothedLine, type ConvertSettings, type Conversion, type StoredConvert,
} from "./convert";

export interface TrackConvertArgs {
  /** The panel is open. */
  open: boolean;
  /** The tracks to convert (listed, ready, list order). */
  rows: readonly TrackRow[];
  pinned: mapDocument.MapDocument | null;
  patch: mapDocument.MapPatch | null;
  unitsPerMm: number | null;
  documentHash: string | null;
}

export interface TrackConvert {
  palette: mapDocument.PaletteGroup[] | null;
  /** The chosen item's key (`doc:<i>` / `patch:<key>`), shown pressed; null until one is picked. */
  chosenKey: string | null;
  onPick: (item: mapDocument.PaletteItem) => void;
  query: string;
  onQuery: (q: string) => void;
  settings: ConvertSettings;
  onSettings: (s: Partial<ConvertSettings>) => void;
  /** Nodes per track at the current settings, the total and the largest; `over` when one exceeds `MAP_NODES_MAX`. */
  nodes: { id: string; count: number }[];
  totalNodes: number;
  maxNodes: number;
  over: boolean;
  /** Tracks too short to convert at these settings (under two coordinates). */
  skipped: string[];
  /** What the viewer draws in the chosen symbol (the draft, `map-rendering.md` §5.5), or null. */
  preview: { ops: mapDocument.PatchOp[]; symbols?: Record<string, mapDocument.PatchSymbol> } | null;
  /** The write and its marks, when a symbol is chosen and a track converts. */
  result: { change: mapDocument.PatchChange; plan: Conversion } | null;
}

function readStored(): StoredConvert {
  try {
    return parseStoredConvert(localStorage.getItem(convertStoreKey));
  } catch {
    return parseStoredConvert(null);
  }
}

function writeStored(s: StoredConvert): void {
  try {
    localStorage.setItem(convertStoreKey, JSON.stringify(s));
  } catch {
    // Storage refused (a private window): not remembered.
  }
}

/** The last smoothing and simplification per line: a tolerance change re-simplifies only; a slider drag keeps one copy. */
const smoothed = new WeakMap<gpsTrack.ProjectedTrack, { windowM: number; line: gpsTrack.ProjectedTrack; tol: number; simplified: gpsTrack.ProjectedTrack | null }>();

function simplifiedLine(line: gpsTrack.ProjectedTrack, s: ConvertSettings): gpsTrack.ProjectedTrack {
  let c = smoothed.get(line);
  if (!c || c.windowM !== s.windowM) {
    c = { windowM: s.windowM, line: smoothedLine(line, s.windowM), tol: NaN, simplified: null };
    smoothed.set(line, c);
  }
  if (!c.simplified || c.tol !== s.toleranceMm) {
    c.simplified = gpsTrack.simplifyTrack(c.line, s.toleranceMm);
    c.tol = s.toleranceMm;
  }
  return c.simplified;
}

export function useTrackConvert(a: TrackConvertArgs): TrackConvert {
  const { open, rows, pinned, patch, unitsPerMm, documentHash } = a;

  // ─── Settings and the symbol, read from the device on opening ──
  const [stored, setStored] = useState<StoredConvert>(() => readStored());
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const palette = useMemo(() => (open && pinned ? convertPalette(mapDocument.mapPalette(pinned, patch)) : null), [open, pinned, patch]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const s = readStored();
      setStored(s);
      setQuery("");
      const item = palette && documentHash ? resolveRemembered(palette, s.symbol, documentHash) : null;
      setChosenKey(item ? itemKey(item) : null);
    }
    wasOpen.current = open;
  }, [open, palette, documentHash]);

  const settings = useMemo(() => clampSettings(stored), [stored]);
  const onSettings = useCallback((next: Partial<ConvertSettings>) => {
    setStored((s) => {
      const out = { ...s, ...clampSettings({ ...s, ...next }) };
      writeStored(out);
      return out;
    });
  }, []);
  const onPick = useCallback((item: mapDocument.PaletteItem) => {
    if (!item.enabled || item.kind !== "line" || !documentHash) return;
    setChosenKey(itemKey(item));
    setStored((s) => {
      const out = { ...s, symbol: rememberedOf(item, documentHash) };
      writeStored(out);
      return out;
    });
  }, [documentHash]);

  // ─── Add ids: one per track, minted when it joins the conversion, shared by the preview and the write ──
  // (A track without one yet is left out of the plan until the next render.) Closing drops them: the next opening
  // makes new lines (§6 answer 1: *Convert* again makes a new line).
  const [addIds, setAddIds] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!open) {
      setAddIds((m) => (m.size > 0 ? new Map() : m));
      return;
    }
    setAddIds((m) => {
      const missing = rows.map((r) => r.meta.id).filter((id) => !m.has(id));
      return missing.length > 0 ? new Map([...m, ...mintAddIds(missing, (now) => newAddId(now))]) : m;
    });
  }, [open, rows]);

  // ─── The lines, the counts, the plan ──
  const lines = useMemo(() => {
    if (!open || !unitsPerMm) return [];
    return rows.flatMap((r) => (r.geometry ? [{ id: r.meta.id, convertedOp: r.meta.convertedOp, simplified: simplifiedLine(r.geometry.line, settings) }] : []));
  }, [open, rows, settings, unitsPerMm]);
  const counts = useMemo(() => {
    const nodes: { id: string; count: number }[] = [];
    const skipped: string[] = [];
    for (const l of lines) {
      const n = unitsPerMm ? nodeCount(l.simplified, unitsPerMm) : 0;
      if (n === 0) skipped.push(l.id);
      else nodes.push({ id: l.id, count: n });
    }
    return { nodes, skipped };
  }, [lines, unitsPerMm]);
  const chosenItem = palette ? findItem(palette, chosenKey) : null;
  const put = useMemo((): Extract<SymbolPut, { ok: true }> | null => {
    if (!chosenItem?.enabled || chosenItem.kind !== "line" || !pinned) return null;
    const p = symbolPut(pinned, patch, chosenItem.ref);
    return p.ok ? p : null;
  }, [chosenItem, pinned, patch]);
  const result = useMemo(() => {
    if (!put || !unitsPerMm || lines.length === 0) return null;
    const plan = planConversion(lines.filter((l) => addIds.has(l.id)), addIds, put.ref, unitsPerMm);
    return plan.ops.length > 0 ? { change: conversionChange(put, plan.ops), plan } : null;
  }, [put, unitsPerMm, lines, addIds]);
  const preview = useMemo(
    () => (result ? { ops: result.plan.ops as mapDocument.PatchOp[], ...(result.change.putSymbols ? { symbols: result.change.putSymbols } : {}) } : null),
    [result],
  );
  const totalNodes = counts.nodes.reduce((s, n) => s + n.count, 0);
  const maxNodes = counts.nodes.reduce((m, n) => Math.max(m, n.count), 0);

  return {
    palette,
    chosenKey: chosenItem?.enabled ? chosenKey : null,
    onPick,
    query,
    onQuery: setQuery,
    settings,
    onSettings,
    nodes: counts.nodes,
    totalNodes,
    maxNodes,
    over: maxNodes > MAP_NODES_MAX,
    skipped: counts.skipped,
    preview,
    result,
  };
}

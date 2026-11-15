/**
 * Map mode (docs/course-editor.md §13; 08 §5.2–§5.3, the Map column; row G6): the event's map corrections — the
 * patch over the pinned document (docs/map-patches.md) — with select, hide and move. Shaped like `useLayoutMode`:
 * the page asks it for the viewer's editor props, the rail, the inspector and its keys, and keeps the undo stack.
 *
 * Course edits are locked here: the editor props carry no control, label, leg or map-click callbacks and the
 * binding is exclusive. Every gesture is one `mapPatch.applyChange` and one undo entry whose undo is the inverse
 * change computed from the patch before it (`model.ts`). The reply becomes the session's copy (`setMapPatch`); a
 * move's draft is kept until the viewer has drawn the patch that carries it (`onPatchDrawn`), so it never jumps back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { mapDocument } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import type { MapViewerEditorProps } from "../../../components/MapViewer";
import type { DocumentHitTest } from "../../../components/VectorMapLayer";
import { loadMapPatch, setMapPatch, type LoadedMapDocument, type MapPatchDelivery } from "../../../lib/map-document-cache";
import type { EditorWrites, PatchWriteResult } from "../../../lib/editor/write-client";
import { boundsMm } from "../../../lib/vector-map";
import { mapSelectBinding, type MapGestureRef } from "../tools/bindings";
import { MAP_RAIL } from "../tools/rail";
import { InspectorSection } from "../Inspector";
import { mapKeyAction } from "./map/keys";
import { MapObjectSection } from "./map/ObjectSection";
import { CorrectionsList } from "./map/Corrections";
import {
  centreOf, changes, correctedRefs, correctionRows, hideChange, hitsObject, inverseChange, isHidden, mapModelFor, moveOp, objectInfo,
  restoreChange, sameRef, stepRef, type CorrectionRow, type MapObjectRef,
} from "./map/model";

type Pt = { x: number; y: number };

export interface MapModeArgs {
  enabled: boolean;
  nameId: string;
  /** The pinned document, loaded; null while it loads or without one. */
  mapDoc: LoadedMapDocument | null;
  /** The event's patch as the session holds it (`useMapPatch`). */
  patch: MapPatchDelivery;
  /** `courses.edit`: the `mapPatch.` writes need it (docs/map-patches.md §3.2). */
  canEdit: boolean;
  writes: EditorWrites;
  run: <T>(op: () => Promise<T>) => Promise<T | undefined>;
  record: (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;
}

export interface MapMode {
  editor: MapViewerEditorProps;
  rail: ReactNode;
  inspector: ReactNode;
  /** Map mode's own keys; true when handled. Undo / redo are the page's. */
  onKey: (e: KeyboardEvent) => boolean;
  /** `H`: the course overprint hidden (the top bar's `editor-hide-overprint`). */
  hideCourse: boolean;
  toggleHideCourse: () => void;
}

/** A refused patch write's message, translated by its code (`PATCH_STALE: …`, §3.2 there; a venue box offline). */
function patchErrorText(e: unknown, t: TFunction<"editor">): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = /^(PATCH_[A-Z_]+)/.exec(message)?.[1];
  if (code) {
    const key = `patchError_${code}`;
    const text = t(key, { defaultValue: "" });
    if (text) return text;
  }
  if (/connectivity/i.test(message)) return t("patchError_offline");
  return message;
}

export function useMapMode(a: MapModeArgs): MapMode {
  const { t, i18n } = useTranslation("editor");
  const utils = trpc.useUtils();
  const { enabled, nameId, mapDoc, canEdit, writes, run, record } = a;

  // ─── The model: the pinned document with the patch over it (taken as enabled) ──
  const hash = mapDoc?.hash ?? null;
  const current: mapDocument.MapPatch | null = a.patch.patch && a.patch.patch.documentHash === hash ? a.patch.patch : null;
  const correctionsOn = current?.enabled ?? true;
  const model = useMemo(() => (enabled && mapDoc ? mapModelFor(mapDoc.hash, mapDoc.bytes, a.patch) : null), [enabled, mapDoc, a.patch]);
  const patchRef = useRef(current);
  patchRef.current = current;

  // ─── Selection, Tab's stack, the draft, the view ──
  const [selected, setSelected] = useState<MapObjectRef | null>(null);
  const [stack, setStack] = useState<MapObjectRef[]>([]);
  const [hideCourse, setHideCourse] = useState(false);
  const [hit, setHit] = useState<DocumentHitTest | null>(null);
  const [viewRequest, setViewRequest] = useState<MapViewerEditorProps["viewRequest"]>(null);
  /** The move being dragged, or committed and waiting until the viewer draws `waitFor`. */
  const [draft, setDraft] = useState<{ ops: mapDocument.PatchOp[]; waitFor: string | null } | null>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const gesture = useRef<MapGestureRef["current"]>(null);
  const clickSeq = useRef(0);

  // Leaving the mode or another document drops it all; the overprint comes back (H is Map mode's own).
  useEffect(() => {
    setSelected(null);
    setStack([]);
    setDraft(null);
    setHideCourse(false);
    gesture.current = null;
  }, [enabled, hash]);
  // A committed draft goes once the canvas shows the patch that carries it.
  useEffect(() => {
    if (draft?.waitFor != null && drawn === draft.waitFor) setDraft(null);
  }, [draft, drawn]);
  // A selected added object whose add went (hidden, reverted, undone) is no longer there.
  useEffect(() => {
    if (selected && model && model.indexOf(selected) === null) setSelected(null);
  }, [selected, model]);

  const onHitTest = useCallback((h: DocumentHitTest | null) => setHit(() => h), []);
  const onPatchDrawn = useCallback((v: string) => setDrawn(v), []);
  const centreOn = useCallback((pt: Pt) => setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, centre: pt })), []);

  // ─── Writes ──
  const deliver = useCallback((res: PatchWriteResult) => {
    setMapPatch(nameId, res);
    utils.course.mapMetadata.setData(undefined, (old) => (old ? { ...old, patchVersion: res.version } : old));
  }, [nameId, utils]);
  /** One `applyChange`; a refusal drops the draft, reloads the metadata and the patch, and says why. */
  const send = useCallback(async (documentHash: string, change: mapDocument.PatchChange): Promise<PatchWriteResult> => {
    try {
      const res = await writes.applyPatchChange(documentHash, change);
      deliver(res);
      return res;
    } catch (e) {
      setDraft(null);
      void utils.course.mapMetadata.invalidate();
      void loadMapPatch(nameId);
      throw new Error(patchErrorText(e, t), { cause: e });
    }
  }, [writes, deliver, utils, nameId, t]);
  /** A gesture's write and its undo entry (§13 "Ops"); `keepDraft`: a move, whose draft stays until drawn. */
  const commit = useCallback((change: mapDocument.PatchChange, keepDraft = false) => {
    const before = patchRef.current;
    const documentHash = hash;
    const inverse = inverseChange(before, change);
    if (!documentHash || !inverse || !changes(before, change)) {
      setDraft(null);
      return;
    }
    void run(async () => {
      const res = await send(documentHash, change);
      if (keepDraft) setDraft((d) => (d ? { ...d, waitFor: res.version } : d));
      record(
        async () => { setDraft(null); await send(documentHash, inverse); },
        async () => { setDraft(null); await send(documentHash, change); },
      );
    });
  }, [hash, run, send, record]);

  const canWrite = enabled && canEdit && !!model && correctionsOn;
  const selectedHidden = !!selected && isHidden(current, selected);
  const canMove = canWrite && !!selected && !selectedHidden && model?.indexOf(selected) != null;

  const hide = useCallback(() => {
    if (!canWrite || !selected || selectedHidden) return;
    commit(hideChange(selected));
  }, [canWrite, selected, selectedHidden, commit]);
  const restore = useCallback(() => {
    if (!canWrite || !selected || !("source" in selected)) return;
    commit(restoreChange(selected));
  }, [canWrite, selected, commit]);
  const revert = useCallback((row: CorrectionRow) => {
    if (!enabled || !canEdit || !hash) return;
    commit({ remove: [row.opId] });
  }, [enabled, canEdit, hash, commit]);
  const setCorrectionsOn = useCallback((on: boolean) => {
    if (!canEdit) return;
    setToggleBusy(true);
    // An event setting, not an undo entry (§13, as auto cuts).
    void run(async () => {
      try {
        deliver(await writes.setPatchEnabled(on));
      } catch (e) {
        throw new Error(patchErrorText(e, t), { cause: e });
      } finally {
        setToggleBusy(false);
      }
    });
  }, [canEdit, run, writes, deliver, t]);

  // ─── Inspector rows, Tab ──
  const lang = i18n.language;
  const rows = useMemo(() => (enabled ? correctionRows(model, current, lang) : []), [enabled, model, current, lang]);
  const info = useMemo(() => (selected && model ? objectInfo(model, selected, lang) : null), [selected, model, lang]);
  const locate = useCallback((ref: MapObjectRef) => {
    setSelected(ref);
    setStack([]);
    const c = model ? centreOf(model, ref) : null;
    if (c) centreOn(c);
  }, [model, centreOn]);
  const step = useCallback((dir: 1 | -1) => {
    // The click's stack while the selection is in it (§13; user 2026-11-15), else the corrected objects.
    if (stack.length > 0 && selected && stack.some((r) => sameRef(r, selected))) {
      setSelected(stepRef(stack, selected, dir));
      return;
    }
    const next = stepRef(correctedRefs(rows), selected, dir);
    if (next) locate(next);
  }, [stack, selected, rows, locate]);

  // ─── The binding ──
  const binding = useMemo(() => mapSelectBinding({
    hit,
    canMove,
    pressOn: (pt, tol) => !!model && !!selected && hitsObject(model, selected, pt, tol),
    gesture,
    clickSeq,
    onSelect: (ref, refs) => { setSelected(ref); setStack(refs); },
    onDrag: (dx, dy) => {
      const op = model && selected ? moveOp(model, patchRef.current, selected, dx, dy) : null;
      setDraft(op ? { ops: [op], waitFor: null } : null);
    },
    onDrop: (dx, dy) => {
      const op = model && selected ? moveOp(model, patchRef.current, selected, dx, dy) : null;
      if (!op) { setDraft(null); return; }
      setDraft({ ops: [op], waitFor: null });
      commit({ put: [op] }, true);
    },
    onCancel: () => setDraft((d) => (d?.waitFor != null ? d : null)),
  }), [hit, canMove, model, selected, commit]);

  const selectedList = useMemo(() => (selected ? [selected] : []), [selected]);
  const draftInput = useMemo(() => (draft ? { ops: draft.ops } : null), [draft]);
  const editor = useMemo<MapViewerEditorProps>(() => ({
    tool: binding,
    viewRequest,
    hideCourse,
    mapObjects: { selected: selectedList, draft: draftInput, onHitTest, onPatchDrawn },
  }), [binding, viewRequest, hideCourse, selectedList, draftInput, onHitTest, onPatchDrawn]);

  // ─── Keys ──
  const fit = useCallback(() => {
    if (mapDoc) setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, bounds: boundsMm(mapDoc.header) }));
  }, [mapDoc]);
  const toggleHideCourse = useCallback(() => setHideCourse((v) => !v), []);
  const onKey = useCallback((e: KeyboardEvent): boolean => {
    const action = mapKeyAction(e);
    if (!action) return false;
    switch (action.kind) {
      case "select-tool": return true;
      case "toggle-overprint": toggleHideCourse(); return true;
      case "fit": fit(); return true;
      case "step": e.preventDefault(); step(action.dir); return true;
      case "hide": e.preventDefault(); hide(); return true;
      case "escape":
        // The viewer cancels a drag in flight first (§3); then the selection; with nothing left, the page leaves fullscreen.
        if (!selected) return false;
        setSelected(null);
        setStack([]);
        return true;
    }
  }, [toggleHideCourse, fit, step, hide, selected]);

  // ─── Rail and inspector ──
  const rail = (
    <div data-testid="editor-tool-rail" className="pointer-events-auto relative flex flex-col gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm p-1 self-start">
      {MAP_RAIL.map((key) => (
        <button key={key} type="button" data-testid={`editor-tool-${key}`} aria-pressed title={t("toolSelect")} aria-label={t("toolSelect")}
          className="w-8 h-8 rounded-md text-xs font-semibold flex items-center justify-center bg-purple-100 text-purple-700 cursor-pointer">
          {key}
        </button>
      ))}
    </div>
  );
  const inspector = !mapDoc ? (
    <p data-testid="editor-map-none" className="px-2.5 py-2 text-xs text-slate-500">{t("mapNone")}</p>
  ) : (
    <>
      {!canEdit && <p data-testid="editor-map-readonly" className="px-2.5 py-1.5 text-[11px] text-slate-500">{t("mapReadOnly")}</p>}
      {canEdit && !correctionsOn && <p data-testid="editor-map-disabled" className="px-2.5 py-1.5 text-[11px] text-amber-700 bg-amber-50">{t("mapDisabled")}</p>}
      <InspectorSection title={t("mapObject")} testId="editor-inspector-map-object">
        <MapObjectSection info={info} hidden={selectedHidden} documentHash={mapDoc.hash} nameId={nameId} canWrite={canWrite} onHide={hide} onRestore={restore} />
      </InspectorSection>
      <InspectorSection title={t("corrections")} testId="editor-corrections">
        <CorrectionsList rows={rows} selected={selected} enabled={correctionsOn} canWrite={canEdit} busy={toggleBusy}
          onLocate={(r) => locate(r.ref)} onRevert={revert} onEnabled={setCorrectionsOn} />
      </InspectorSection>
    </>
  );

  return { editor, rail, inspector, onKey, hideCourse, toggleHideCourse };
}

/**
 * Map mode (docs/course-editor.md §13; 08 §5.2–§5.3, the Map column; row G6): the event's map corrections — the
 * patch over the pinned document (docs/map-patches.md) — with select, hide and move, the nodes tool `N` (§13
 * "Nodes", G7), the drawing tools `P` `L` `A`, the symbol picker, *Change symbol* and *Rotation* (§13 "Drawing",
 * "Symbol picker", G9), the GPS tracks section with its conversion into lines (§13 "GPS tracks", G25, G26), the
 * unresolved corrections' *Attach* / *Drop* as undo entries and *Save corrections to the club map* (§13 "Unresolved",
 * "Promote", G12b), the line and area operations *Reverse*, *Split at node*, *Join*, *Cut hole* and *Remove hole* (§13
 * "Line and area operations", G10). Shaped like `useLayoutMode`:
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
import { mapDocument } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import type { MapViewerEditorProps } from "../../../components/MapViewer";
import type { DocumentHitTest } from "../../../components/VectorMapLayer";
import { loadMapPatch, setMapPatch, type LoadedMapDocument, type MapPatchDelivery } from "../../../lib/map-document-cache";
import type { EditorWrites, PatchWriteResult } from "../../../lib/editor/write-client";
import { boundsMm } from "../../../lib/vector-map";
import {
  mapDrawBinding, mapNodesBinding, mapPickBinding, mapPointBinding, mapSelectBinding, mapSplitBinding, mapTBinding, withTrackLayer, type Gesture, type MapGestureRef, type MapNodeFocus,
  type MapNodesGestureRef, type MapPointGestureRef,
} from "../tools/bindings";
import { isMapDrawTool, MAP_DRAW_KIND, MAP_RAIL, type MapRailTool } from "../tools/rail";
import { step as polygonStep, type PolygonState } from "../tools/polygon";
import type { ToolPointer } from "../../../components/MapViewer";
import { deleteVertex, type Vertex } from "../../../lib/editor/geometry-edit";
import { snapIndexOf, type SnapIndex } from "../../../lib/editor/snap";
import { InspectorSection } from "../Inspector";
import { mapKeyAction } from "./map/keys";
import { MapObjectSection, type ShapeOpButton } from "./map/ObjectSection";
import {
  areaRings, cutHoleChange, joinChange, lineShape, removeHoleChange, reverseChange, snapEndsChange, splitChange, type ShapeReason,
} from "./map/shape-ops";
import { CorrectionsList } from "./map/Corrections";
import { usePromote } from "./map/Promote";
import { entryPickerKind, unresolvedRows, type UnresolvedRow } from "./map/unresolved";
import { MAP_NODES_MAX, nodeSnapIndex, nodesOf, nodesOp, ringRule, withRing, type NodePath } from "./map/nodes";
import { useMapTracks } from "./map/tracks/useMapTracks";
import { TracksPanel } from "./map/tracks/TracksPanel";
import { ConvertPanel } from "./map/tracks/ConvertPanel";
import { useTrackConvert } from "./map/tracks/useTrackConvert";
import { SymbolPicker } from "./map/SymbolPicker";
import { findItem, itemKey } from "./map/palette";
import { drawOp, minNodes, type DrawKind } from "./map/draw";
import { addChange, angleChange, isOrientableRef, kindOfType, newAddId, refOfSymbolKey, resymbolChange, symbolKey, symbolPut } from "./map/symbols";
import {
  centreOf, changes, correctedRefs, drawnCovers, correctionRows, hideChange, hitsObject, inverseChange, isHidden, mapModelFor, moveOp, objectInfo,
  refKey, refOfOp, restoreChange, sameRef, stepRef, type CorrectionRow, type MapModel, type MapObjectRef,
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
  /** Drops the page's undo entries `drop` matches (a promote drops Map mode's patch entries, §13 "Promote"). */
  forget: (drop: (entry: object) => boolean) => void;
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

/** The rail buttons' labels (`editor.json`). */
const RAIL_LABEL = { V: "toolSelect", N: "toolNodes", P: "toolMapPoint", L: "toolMapLine", A: "toolMapArea", T: "toolMapTracks" } as const satisfies Record<MapRailTool, string>;

export function useMapMode(a: MapModeArgs): MapMode {
  const { t, i18n } = useTranslation("editor");
  const utils = trpc.useUtils();
  const { enabled, nameId, mapDoc, canEdit, writes, run, record, forget } = a;

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
  const [draft, setDraft] = useState<{ ops: mapDocument.PatchOp[]; symbols?: Record<string, mapDocument.PatchSymbol>; waitFor: string | null } | null>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  /** *Apply corrections* while its write is in flight: the box shows the value asked for. */
  const [toggling, setToggling] = useState<boolean | null>(null);
  const gesture = useRef<MapGestureRef["current"]>(null);
  /** The armed tool: `V` select, `N` nodes (§13 "Nodes"); the focused node and Map mode's own snapping toggle. */
  const [tool, setTool] = useState<MapRailTool>("V");
  const [focusState, setFocusState] = useState<{ owner: string; focus: MapNodeFocus } | null>(null);
  const [snapping, setSnapping] = useState(false);
  const nodeGesture = useRef<MapNodesGestureRef["current"]>(null);
  /** The patch a node press was made on: a release that finds another one is dropped (§13 "Nodes", "Writes"). */
  const pressPatch = useRef<mapDocument.MapPatch | null>(null);
  const snapCache = useRef<{ model: MapModel; key: string; index: SnapIndex | null } | null>(null);
  const clickSeq = useRef(0);
  /** A gesture's write is in flight: the next gesture waits (its `before` would be stale, §13 "Ops"). */
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  /** A promote is being sent or runs (§13 "Promote"): every patch write is refused here, not only by its gate. */
  const lockedRef = useRef(false);
  /** Drawing (§13 "Drawing"): the chosen symbol per kind, the line / area being drawn, its add id, the hover. */
  const [chosenState, setChosenState] = useState<{ hash: string | null; byKind: Partial<Record<DrawKind, string>> }>({ hash: null, byKind: {} });
  const [poly, setPoly] = useState<PolygonState | null>(null);
  const drawId = useRef<string | null>(null);
  const [drawHover, setDrawHover] = useState<Pt | null>(null);
  const drawGesture = useRef<Gesture>(null);
  const pointGesture = useRef<MapPointGestureRef["current"]>(null);
  /** Bumped while a point is aimed: its direction line is drawn from the gesture (the binding's `redraw`). */
  const [aimTick, setAimTick] = useState(0);
  /** The add a finished line or area wrote: selected once the model has it. */
  const pendingSelect = useRef<MapObjectRef | null>(null);
  /** *Change symbol*'s picker is open for this selection (`refKey`; another selection closes it); the picker's search. */
  const [changingFor, setChangingFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The GPS tracks' convert panel is open (§13 "GPS tracks: convert", G26): `V` armed, its preview the draft. */
  const [convertOpen, setConvertOpen] = useState(false);
  /** A `symbol` entry's *Attach* has the palette open under its row (§13 "Unresolved", G12b): the entry's key. */
  const [attaching, setAttaching] = useState<string | null>(null);
  /**
   * A one-shot line or area operation armed on the selection (§13 "Line and area operations", G10): *Join*'s pick or
   * *Cut hole*'s ring; `key` the selection it was armed on (another one drops it), `reason` why the last pick or ring
   * was refused.
   */
  const [armedState, setArmedState] = useState<{ kind: "join" | "hole"; key: string; reason: ShapeReason | null } | null>(null);
  /** The undo entries `commit` recorded: the patch's, which a promote drops (§13 "Promote"). */
  const recorded = useRef(new WeakSet<object>());

  // Leaving the mode or another document drops it all; the overprint comes back (H is Map mode's own).
  useEffect(() => {
    setSelected(null);
    setStack([]);
    setDraft(null);
    setHideCourse(false);
    setTool("V");
    setFocusState(null);
    setSnapping(false);
    setPoly(null);
    setChangingFor(null);
    setQuery("");
    setConvertOpen(false);
    setAttaching(null);
    setArmedState(null);
    drawId.current = null;
    pendingSelect.current = null;
    gesture.current = null;
    nodeGesture.current = null;
    drawGesture.current = null;
    pointGesture.current = null;
  }, [enabled, hash]);
  // The chosen symbols belong to the document: kept across leaving and re-entering the mode, dropped for another
  // document (§13 "Drawing").
  const chosen = chosenState.hash === hash ? chosenState.byKind : {};
  // The focused node belongs to the selection and the tool it was set in: another one drops it (§13 "Nodes", "Focus").
  const focusOwner = `${selected ? refKey(selected) : ""}|${tool}`;
  const focus = focusState?.owner === focusOwner ? focusState.focus : null;
  const setFocus = useCallback((f: MapNodeFocus | null) => setFocusState(f ? { owner: focusOwner, focus: f } : null), [focusOwner]);
  // A committed draft goes once the canvas shows the patch that carries it.
  useEffect(() => {
    if (draft?.waitFor != null && drawnCovers(drawn, draft.waitFor)) setDraft(null);
  }, [draft, drawn]);
  // A selected added object whose add went (hidden, reverted, undone) is no longer there.
  useEffect(() => {
    if (selected && model && model.indexOf(selected) === null) setSelected(null);
  }, [selected, model]);
  // A finished line or area is selected once the model has its add (§13 "Drawing").
  useEffect(() => {
    const p = pendingSelect.current;
    if (p && model && model.indexOf(p) !== null) {
      pendingSelect.current = null;
      setSelected(p);
      setStack([]);
    }
  }, [model]);
  // *Change symbol* belongs to the selection it was opened on.
  const selectedKey = selected ? refKey(selected) : null;
  const changing = changingFor !== null && changingFor === selectedKey;
  const setChanging = useCallback((open: boolean) => setChangingFor(open ? selectedKey : null), [selectedKey]);
  // A line or area operation belongs to the selection it was armed on.
  const armed = armedState && armedState.key === selectedKey ? armedState : null;

  const onHitTest = useCallback((h: DocumentHitTest | null) => setHit(() => h), []);
  const onPatchDrawn = useCallback((v: string) => setDrawn(v), []);
  const centreOn = useCallback((pt: Pt) => setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, centre: pt })), []);
  // GPS tracks (§13 "GPS tracks", G25): the reference layer over every Map-mode tool and the inspector's section.
  const fitTo = useCallback((bounds: { minX: number; minY: number; maxX: number; maxY: number }) => setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, bounds })), []);
  // `T` picking a GPS track drops the map line selection (G32: nodes show on one kind of thing at a time).
  const onTrackPicked = useCallback(() => { setSelected(null); setStack([]); }, []);
  const tracks = useMapTracks({ enabled, nameId, mapDoc, canEdit, writes, run, record, onLocate: fitTo, armed: tool === "T", onTrackPicked });

  // ─── Writes ──
  const deliver = useCallback((res: PatchWriteResult) => {
    // An older reply than the copy (MAP-8) changes nothing: the newer delivery and its version stay.
    if (!setMapPatch(nameId, res)) return;
    utils.course.mapMetadata.setData(undefined, (old) => (old ? { ...old, patchVersion: res.version } : old));
  }, [nameId, utils]);
  /**
   * One `applyChange` (or `via`, another `mapPatch` write of the same change: *Attach*'s procedure); a refusal drops
   * the draft, reloads the metadata and the patch, and says why.
   */
  const send = useCallback(async (documentHash: string, change: mapDocument.PatchChange, via?: () => Promise<PatchWriteResult>): Promise<PatchWriteResult> => {
    try {
      const res = await (via ? via() : writes.applyPatchChange(documentHash, change));
      deliver(res);
      return res;
    } catch (e) {
      setDraft(null);
      void utils.course.mapMetadata.invalidate();
      void loadMapPatch(nameId);
      throw new Error(patchErrorText(e, t), { cause: e });
    }
  }, [writes, deliver, utils, nameId, t]);
  /**
   * A gesture's write and its undo entry (§13 "Ops"); `keepDraft`: a move, whose draft stays until drawn. `follow`: a
   * write of another store that belongs to the same entry (G26's track marks), after the patch on do, undo and redo
   * alike. The follow-up runs in its own `run`, so a refused one is reported without failing the patch's step: the
   * entry is kept (on undo and redo too). On do the entry is recorded once the follow-up has settled, so it cannot be
   * undone while its follow-up is in flight. `via`: the do and redo steps' write when it is not `applyChange` of
   * `change` (*Attach*, whose server-side procedure makes `change`; the undo is still `applyChange` of the inverse).
   * False when refused (a write in flight, nothing to change).
   */
  const commit = useCallback((
    change: mapDocument.PatchChange,
    keepDraft = false,
    follow?: { after: () => Promise<unknown>; undo: () => Promise<unknown> },
    via?: (documentHash: string) => Promise<PatchWriteResult>,
  ): boolean => {
    const before = patchRef.current;
    const documentHash = hash;
    const inverse = inverseChange(before, change);
    if (writingRef.current || lockedRef.current) return false;
    if (!documentHash || !inverse || !changes(before, change)) {
      setDraft(null);
      return false;
    }
    writingRef.current = true;
    setWriting(true);
    void run(async () => {
      try {
        const doIt = via ? () => via(documentHash) : undefined;
        const res = await send(documentHash, change, doIt);
        if (keepDraft) setDraft((d) => (d ? { ...d, waitFor: res.version } : d));
        if (follow) await run(follow.after);
        // Undo / redo drop the focused node: its index may name another node then (§13 "Nodes").
        const entry = record(
          async () => { setDraft(null); setFocusState(null); await send(documentHash, inverse); if (follow) await run(follow.undo); },
          async () => { setDraft(null); setFocusState(null); await send(documentHash, change, doIt); if (follow) await run(follow.after); },
        );
        if (entry && typeof entry === "object") recorded.current.add(entry);
      } finally {
        writingRef.current = false;
        setWriting(false);
      }
    });
    return true;
  }, [hash, run, send, record]);

  // ─── Inspector rows; promote (§13 "Promote"): while one runs Map mode is read-only ──
  const lang = i18n.language;
  const rows = useMemo(() => (enabled ? correctionRows(model, current, lang) : []), [enabled, model, current, lang]);
  const forgetMine = useCallback(() => forget((e) => recorded.current.has(e)), [forget]);
  const promote = usePromote({
    enabled: enabled && !!mapDoc, nameId, canEdit, correctionsOn, applicable: rows.filter((r) => r.issue === null).length, writing, onStarted: forgetMine,
  });
  const locked = promote.locked;
  lockedRef.current = locked;
  /** `courses.edit` and no promote running: what every `mapPatch` write needs (revert, the toggle, drop: also while off). */
  const canPatch = enabled && canEdit && !locked;
  const canWrite = canPatch && !!model && correctionsOn && !writing;
  const selectedHidden = !!selected && isHidden(current, selected);
  // While the convert panel is open its preview is the draft: no move drag (§13 "GPS tracks: convert").
  const canMove = canWrite && !convertOpen && !!selected && !selectedHidden && model?.indexOf(selected) != null;
  /** Drawing's lasting conditions (§13 "Drawing"): `courses.edit`, corrections on, a document — a write in flight aside. */
  const canDraw = canPatch && !!model && correctionsOn;
  // `T` (§13 "Split tool", G27, G32) splits GPS tracks and map lines: off only when both are; back to V then.
  const tOff = tracks.toolOff && !canDraw ? tracks.toolOff : null;
  useEffect(() => { if (tool === "T" && tOff) setTool("V"); }, [tool, tOff]);
  const drawTool = isMapDrawTool(tool) ? tool : null;
  const drawKind: DrawKind | null = drawTool ? MAP_DRAW_KIND[drawTool] : null;
  // An armed drawing tool goes back to V when drawing becomes disabled.
  useEffect(() => {
    if (drawTool && !canDraw) { setTool("V"); setPoly(null); drawId.current = null; }
  }, [drawTool, canDraw]);

  const hide = useCallback(() => {
    if (!canWrite || !selected || selectedHidden) return;
    commit(hideChange(selected));
  }, [canWrite, selected, selectedHidden, commit]);
  const restore = useCallback(() => {
    if (!canWrite || !selected || !("source" in selected)) return;
    commit(restoreChange(selected));
  }, [canWrite, selected, commit]);
  const revert = useCallback((row: CorrectionRow) => {
    if (!canPatch || !hash) return;
    setFocusState(null); // its index may name another node after the revert (§13 "Nodes", "Focus")
    commit({ remove: [row.opId] });
  }, [canPatch, hash, commit]);
  const setCorrectionsOn = useCallback((on: boolean) => {
    if (!canPatch) return;
    setToggling(on);
    // An event setting, not an undo entry (§13, as auto cuts).
    void run(async () => {
      try {
        deliver(await writes.setPatchEnabled(on));
      } catch (e) {
        throw new Error(patchErrorText(e, t), { cause: e });
      } finally {
        setToggling(null);
      }
    });
  }, [canPatch, run, writes, deliver, t]);

  // ─── Unresolved corrections (§13 "Unresolved"; G11, G12b): Attach and Drop are gestures, one undo entry each ──
  const unresolved = useMemo(() => (enabled ? unresolvedRows(current) : []), [enabled, current]);
  const attachingRow = attaching ? unresolved.find((r) => r.key === attaching) ?? null : null;
  // The palette belongs to an entry still listed, while attaching is possible.
  useEffect(() => {
    if (attaching && (!attachingRow || (!canWrite && !writing))) setAttaching(null);
  }, [attaching, attachingRow, canWrite, writing]);
  const locateEntry = useCallback((row: UnresolvedRow) => { if (row.centre) centreOn(row.centre); }, [centreOn]);
  const dropEntry = useCallback((row: UnresolvedRow) => {
    if (!canPatch || !hash) return;
    if (attaching === row.key) setAttaching(null);
    commit({ removeUnresolved: [row.key] });
  }, [canPatch, hash, attaching, commit]);
  /**
   * *Attach*: the change computed here on the pinned document (the inverse needs it; a refusal is said without a
   * write), sent through `mapPatch.attachUnresolved` — the server's copy makes the same change.
   */
  const attachWith = useCallback((row: UnresolvedRow, at: { sourceIndex?: number; symbol?: mapDocument.PatchSymbolRef }) => {
    if (!canWrite || !model || !current) return;
    const r = mapDocument.attachUnresolved(current, row.key, model.pinned, at.sourceIndex, at.symbol);
    if (!r.ok) {
      void run(async () => { throw new Error(`${t("patchError_PATCH_ATTACH_REFUSED")} (${r.reason})`); });
      return;
    }
    setAttaching(null);
    commit(r.change, false, undefined, (documentHash) => writes.attachUnresolvedPatch(documentHash, row.key, at));
  }, [canWrite, model, current, run, t, commit, writes]);

  // ─── Tab ──
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
    const next = stepRef(correctedRefs(rows), selected, dir); // rows whose object is in the document
    if (next) locate(next);
  }, [stack, selected, rows, locate]);

  // ─── Nodes (§13 "Nodes"): the selected line's or area's rings, from the draft while there is one ──
  const draftCoords = useMemo(() => {
    const op = selected ? draft?.ops.find((o) => sameRef(refOfOp(o), selected)) : undefined;
    return op && op.op !== "hide" && op.op !== "resymbol" ? op.coords : null;
  }, [draft, selected]);
  const nodes = useMemo(
    // No node editing while a promote runs (§13 "Promote"): `canPatch`, not `canEdit`.
    () => (tool === "N" && selected && model ? nodesOf(model, selected, { canEdit: canPatch, correctionsOn, coords: draftCoords }) : null),
    [tool, selected, model, canPatch, correctionsOn, draftCoords],
  );
  const nodePath: NodePath | null = nodes && "path" in nodes ? nodes.path : null;
  const pathRef = useRef(nodePath);
  pathRef.current = nodePath;
  /** The op of ring `ring` as `vertices` (null: nothing changes). */
  const ringOp = useCallback((ring: number, vertices: Vertex[]) => {
    const path = pathRef.current;
    return model && path ? nodesOp(model, patchRef.current, withRing(path, ring, vertices)) : null;
  }, [model]);
  /** A node gesture's write (§13 "Ops"): its draft kept until drawn, the node `index` focused after. */
  const commitNodes = useCallback((ring: number, vertices: Vertex[], index: number | null) => {
    if (writingRef.current) return;
    const op = ringOp(ring, vertices);
    setFocus(index === null ? null : { ring, index });
    if (!op) { setDraft((d) => (d?.waitFor != null ? d : null)); return; }
    setDraft({ ops: [op], waitFor: null });
    commit({ put: [op] }, true);
  }, [ringOp, commit, setFocus]);
  /** A press's release (a drag, an Alt-click): dropped when the patch changed since the press or a write is in flight. */
  const releaseNodes = useCallback((ring: number, vertices: Vertex[], index: number | null) => {
    if (pressPatch.current !== patchRef.current || writingRef.current) { setDraft((d) => (d?.waitFor != null ? d : null)); return; }
    commitNodes(ring, vertices, index);
  }, [commitNodes]);
  const deleteNode = useCallback(() => {
    const ring = focus ? nodePath?.rings[focus.ring] : undefined;
    // Ignored while a node or grip is held: the release would write over it.
    if (!focus || !ring || writingRef.current || nodeGesture.current) return;
    // Down to the ring's minimum; at it nothing happens (§13 "Nodes", as §7).
    const next = deleteVertex(ring.vertices, focus.index, ringRule(ring).min);
    if (next) commitNodes(focus.ring, next, null);
  }, [focus, nodePath, commitNodes]);
  /** Node snapping (§13 "Snapping"): the effective document without the edited object, built on first use. */
  const snapNode = useMemo(() => {
    if (!snapping || !model || !selected) return null;
    const key = refKey(selected);
    return (pt: Pt): Pt => {
      let c = snapCache.current;
      if (!c || c.model !== model || c.key !== key) snapCache.current = c = { model, key, index: nodeSnapIndex(model, selected) };
      return c.index?.nearest(pt) ?? pt;
    };
  }, [snapping, model, selected]);

  // ─── Drawing and the symbol picker (§13 "Drawing", "Symbol picker") ──
  const pickerKind: DrawKind | null = drawKind ?? (changing && info ? kindOfType(info.type) : null) ?? (attachingRow ? entryPickerKind(attachingRow.entry) : null);
  const pinned = model?.pinned ?? null;
  const palette = useMemo(() => (pickerKind && pinned ? mapDocument.mapPalette(pinned, current) : null), [pickerKind, pinned, current]);
  /** The drawing tool's symbol: the chosen item, while it is in the palette and enabled; its first-use put. */
  const chosenKey = drawKind ? chosen[drawKind] ?? null : null;
  const chosenItem = palette ? findItem(palette, chosenKey) : null;
  const chosenPut = useMemo(() => {
    const ref = chosenItem?.enabled && chosenKey ? refOfSymbolKey(chosenKey) : null;
    if (!ref || !pinned) return null;
    const put = symbolPut(pinned, current, ref);
    return put.ok ? put : null;
  }, [chosenItem, chosenKey, pinned, current]);
  const chosenOrientable = !!chosenPut && !!pinned && drawKind === "point" && isOrientableRef(pinned, current, chosenPut.ref);
  /** Snapping for placed points and nodes: the whole effective document (nothing drawn is in it yet). */
  const drawSnapIndex = useMemo(() => (snapping && (drawTool || armed?.kind === "hole") && model ? snapIndexOf(model.doc) : null), [snapping, drawTool, armed?.kind, model]);
  const drawSnap = useCallback((pt: Pt): Pt => drawSnapIndex?.nearest(pt) ?? pt, [drawSnapIndex]);
  const keepWaiting = useCallback(() => setDraft((d) => (d?.waitFor != null ? d : null)), []);
  const dropDrawing = useCallback(() => {
    setPoly(null);
    drawId.current = null;
    drawGesture.current = null;
    keepWaiting();
  }, [keepWaiting]);
  /** One drawn object's write (§13 "Ops"): the add with its symbol's first use, its draft kept until drawn. */
  const commitAdd = useCallback((op: mapDocument.PatchOp | null) => {
    if (!op || !chosenPut || writingRef.current) return false;
    setDraft({ ops: [op], ...(chosenPut.putSymbols ? { symbols: chosenPut.putSymbols } : {}), waitFor: null });
    commit(addChange(chosenPut, op), true);
    return true;
  }, [chosenPut, commit]);
  /** The line or area as a draft from its minimum (hover excluded: it sends nothing to the worker). */
  const drawDraft = useCallback((state: PolygonState) => {
    if (!model || !chosenPut || (drawKind !== "line" && drawKind !== "area")) return;
    if (!drawId.current) drawId.current = newAddId();
    const op = drawOp(drawId.current, drawKind, chosenPut.ref, model.unitsPerMm, { vertices: state.vertices });
    if (op) setDraft({ ops: [op], ...(chosenPut.putSymbols ? { symbols: chosenPut.putSymbols } : {}), waitFor: null });
    else keepWaiting();
  }, [model, chosenPut, drawKind, keepWaiting]);
  const finishDrawing = useCallback((vertices: PolygonState["vertices"]) => {
    if (!model || !chosenPut || (drawKind !== "line" && drawKind !== "area") || writingRef.current) return;
    if (vertices.length < minNodes(drawKind)) return;
    const id = drawId.current ?? newAddId();
    if (!commitAdd(drawOp(id, drawKind, chosenPut.ref, model.unitsPerMm, { vertices }))) return;
    setPoly(null);
    drawId.current = null;
    drawGesture.current = null;
    // Back to V with the new object selected once the reply has it (08 §5.3 "Area tools").
    pendingSelect.current = { added: id };
    setTool("V");
  }, [model, chosenPut, drawKind, commitAdd]);
  const pointBinding = useMemo(() => (drawKind !== "point" ? null : mapPointBinding({
    canPlace: !!chosenPut && !writing,
    orientable: chosenOrientable,
    snap: drawSnap,
    gesture: pointGesture,
    onPlace: (at, angle) => {
      if (!model || !chosenPut) return;
      const id = drawId.current ?? newAddId();
      drawId.current = null;
      commitAdd(drawOp(id, "point", chosenPut.ref, model.unitsPerMm, { at, angle }));
    },
    onAim: (at, angle) => {
      if (!model || !chosenPut) return;
      if (!drawId.current) drawId.current = newAddId();
      const op = drawOp(drawId.current, "point", chosenPut.ref, model.unitsPerMm, { at, angle });
      if (op) setDraft({ ops: [op], ...(chosenPut.putSymbols ? { symbols: chosenPut.putSymbols } : {}), waitFor: null });
    },
    onCancel: () => { drawId.current = null; keepWaiting(); },
    redraw: () => setAimTick((n) => n + 1),
    // aimTick: the direction line follows the gesture.
  })), [drawKind, chosenPut, writing, chosenOrientable, drawSnap, model, commitAdd, keepWaiting, aimTick]);
  const onDrawHover = useCallback((p: ToolPointer | null) => setDrawHover(p ? drawSnap(p.pt) : null), [drawSnap]);
  const lineBinding = useMemo(() => (drawKind !== "line" && drawKind !== "area" ? null : mapDrawBinding({
    gesture: drawGesture,
    poly: poly ?? { kind: drawKind === "line" ? "map_line" : "map_area", vertices: [] },
    hover: chosenPut ? drawHover : null,
    onHover: onDrawHover,
    onPoly: (next) => {
      if (!chosenPut) return; // no symbol chosen: a click draws nothing (§13 "Drawing")
      setPoly(next);
      drawDraft(next);
    },
    onDone: finishDrawing,
    onCancel: dropDrawing,
    snap: drawSnap,
    canClose: () => !writingRef.current && !!chosenPut,
  })), [drawKind, poly, chosenPut, drawHover, onDrawHover, drawDraft, finishDrawing, dropDrawing, drawSnap]);
  // ─── Line and area operations (§13 "Line and area operations", G10) ──
  /** Drops an armed *Join* or *Cut hole*, the hole's ring with it (its draft too, unless a write waits for it). */
  const disarm = useCallback(() => {
    setArmedState(null);
    setPoly(null);
    drawGesture.current = null;
    keepWaiting();
  }, [keepWaiting]);
  // Dropped with another selection, a hidden one, or when writing becomes impossible (a promote, corrections off).
  useEffect(() => {
    if (armedState && (armedState.key !== selectedKey || !canDraw || selectedHidden)) disarm();
  }, [armedState, selectedKey, canDraw, selectedHidden, disarm]);
  /** The cut hole's ring as the area's draft, from 3 nodes (§13 "Drawing", as an area). */
  const holeDraft = useCallback((state: PolygonState) => {
    if (!model || !selected || state.vertices.length < 3) { keepWaiting(); return; }
    const r = cutHoleChange(model, patchRef.current, selected, state.vertices);
    if (r && "change" in r && r.change.put) setDraft({ ops: r.change.put, waitFor: null });
    else keepWaiting();
  }, [model, selected, keepWaiting]);
  /** *Cut hole*'s closed ring: one `modify` (an added area's `add` rewritten), its draft kept until drawn. */
  const finishHole = useCallback((vertices: PolygonState["vertices"]) => {
    if (!model || !selected || writingRef.current || vertices.length < 3) return;
    const r = cutHoleChange(model, patchRef.current, selected, vertices);
    if (!r) return;
    if ("reason" in r) { setArmedState((a) => (a ? { ...a, reason: r.reason } : a)); return; }
    setDraft({ ops: r.change.put ?? [], waitFor: null });
    if (!commit(r.change, true)) return;
    setArmedState(null);
    setPoly(null);
    drawGesture.current = null;
    setFocusState(null); // the rings changed: a focused index may name another node
  }, [model, selected, commit]);
  /**
   * *Join*'s pick (§13 answers 1–3): the first line under the click that is not the selection, else the selection
   * itself (closed into a loop); a refused pick keeps *Join* armed and says why.
   */
  const onJoinPick = useCallback((hits: MapObjectRef[]) => {
    if (!model || !selected || writingRef.current) return;
    const isLine = (r: MapObjectRef) => {
      const i = model.indexOf(r);
      return i !== null && model.doc.attrs.type[i] === mapDocument.OBJECT_TYPE.line;
    };
    const other = hits.find((r) => !sameRef(r, selected) && isLine(r));
    const picked = other ?? (hits.some((r) => sameRef(r, selected)) ? selected : null);
    const r: ReturnType<typeof joinChange> = picked ? joinChange(model, patchRef.current, selected, picked) : { reason: "not-line" };
    if (!r) return;
    if ("reason" in r) { setArmedState((a) => (a ? { ...a, reason: r.reason } : a)); return; }
    if (commit(r.change)) {
      setArmedState(null);
      setFocusState(null);
    }
  }, [model, selected, commit]);
  /**
   * One operation's change (§13 "Ops"): one write and one undo entry; once it goes the focused node is dropped, and so
   * is an armed *Join* / *Cut hole* (its ring made on the old shape).
   */
  const runOp = useCallback((r: ReturnType<typeof reverseChange>) => {
    if (!r || "reason" in r) return;
    if (commit(r.change)) {
      setFocusState(null);
      if (armedState) disarm();
    }
  }, [commit, armedState, disarm]);
  /** The focused node of the nodes tool, as the operations name it. */
  const opFocus = tool === "N" ? focus : null;
  const reverse = useCallback(() => {
    if (!canWrite || !model || !selected || selectedHidden) return;
    runOp(reverseChange(model, current, selected));
  }, [canWrite, model, selected, selectedHidden, current, runOp]);
  const splitAtNode = useCallback(() => {
    if (!canWrite || !model || !selected || selectedHidden) return;
    runOp(splitChange(model, current, selected, opFocus && opFocus.ring === 0 ? opFocus.index : null, newAddId()));
  }, [canWrite, model, selected, selectedHidden, current, opFocus, runOp]);
  const removeHole = useCallback(() => {
    if (!canWrite || !model || !selected || selectedHidden) return;
    runOp(removeHoleChange(model, current, selected, opFocus ? opFocus.ring : null));
  }, [canWrite, model, selected, selectedHidden, current, opFocus, runOp]);
  /** *Snap ends* on an added line (§13 "GPS tracks: junctions", G28): one op, one undo entry. */
  const snapEnds = useCallback(() => {
    if (!canWrite || !model || !selected || selectedHidden) return;
    runOp(snapEndsChange(model, current, selected));
  }, [canWrite, model, selected, selectedHidden, current, runOp]);

  /** Arms a rail tool; a drawing tool only while drawing is enabled, dropping the selection and *Change symbol*. */
  const armTool = useCallback((next: MapRailTool) => {
    if ((isMapDrawTool(next) && !canDraw) || (next === "T" && tOff)) return;
    setArmedState(null);
    setPoly(null);
    drawId.current = null;
    drawGesture.current = null;
    pointGesture.current = null;
    setChanging(false);
    setAttaching(null);
    if (next !== "V") setConvertOpen(false); // the convert panel keeps V (§13 "GPS tracks: convert")
    if (isMapDrawTool(next)) { setSelected(null); setStack([]); pendingSelect.current = null; }
    setTool(next);
  }, [canDraw, setChanging, tOff]);
  /** `armTool` that also drops a drawing in progress from the draft (its op had an id; a waiting write's stays). */
  const armDropping = useCallback((next: MapRailTool) => {
    if (drawId.current) keepWaiting();
    armTool(next);
  }, [armTool, keepWaiting]);
  /**
   * *Join* / *Cut hole* (§13 answer 7): a one-shot armed state on the selection; the button again drops it. Arming
   * closes *Change symbol*, the attach palette and the convert panel and keeps `V` or `N` (another tool goes to `V`).
   */
  const armOp = useCallback((kind: "join" | "hole") => {
    if (!canWrite || !selectedKey) return;
    if (armed?.kind === kind) { disarm(); return; }
    if (tool !== "V" && tool !== "N") armTool("V");
    setChanging(false);
    setAttaching(null);
    setConvertOpen(false);
    setPoly(null);
    drawGesture.current = null;
    keepWaiting();
    setArmedState({ kind, key: selectedKey, reason: null });
  }, [canWrite, selectedKey, armed?.kind, disarm, tool, armTool, setChanging, keepWaiting]);
  /** *Attach* (§13 "Unresolved"): a `symbol` entry opens the palette under its row, an object entry attaches to the selection. */
  const attachEntry = useCallback((row: UnresolvedRow) => {
    if (!canWrite) return;
    if (row.attach === "symbol") {
      // The palette under the row; one palette at a time (§13 "Symbol picker"): V armed, a drawing in progress dropped,
      // *Change symbol* (by armTool) and the convert panel closed.
      if (attaching === row.key) { setAttaching(null); return; }
      armDropping("V");
      setConvertOpen(false);
      setQuery("");
      setAttaching(row.key);
      return;
    }
    if (selected && "source" in selected) attachWith(row, { sourceIndex: selected.source });
  }, [canWrite, attaching, armDropping, selected, attachWith]);
  /** The picker's pick: the tool's symbol, or *Change symbol*'s write (one op, one undo entry; §13 "Ops"). */
  const pick = useCallback((item: mapDocument.PaletteItem) => {
    if (!item.enabled) return;
    if (drawKind) {
      setChosenState((c) => ({ hash, byKind: { ...(c.hash === hash ? c.byKind : {}), [drawKind]: itemKey(item) } }));
      return;
    }
    if (attachingRow && !changing) { attachWith(attachingRow, { symbol: item.ref }); return; }
    if (!canWrite || !model || !selected || selectedHidden) return;
    const put = symbolPut(model.pinned, current, item.ref);
    if (!put.ok) return;
    const change = resymbolChange(model, current, selected, put);
    setChanging(false);
    if (change) commit(change);
  }, [drawKind, hash, attachingRow, changing, attachWith, canWrite, model, selected, selectedHidden, current, commit, setChanging]);
  const rotate = useCallback((tenths: number) => {
    if (!canWrite || !model || !selected || selectedHidden) return;
    const change = angleChange(model, current, selected, tenths);
    if (change) commit(change);
  }, [canWrite, model, selected, selectedHidden, current, commit]);
  const selectedOrientable = !!info && !!model && info.type === mapDocument.OBJECT_TYPE.point && isOrientableRef(model.pinned, current, info.symbol);
  /** The line and area operations that apply to the selection, each with why it cannot run now (§13 answer 7). */
  const shapeOps = useMemo((): ShapeOpButton[] => {
    if (!model || !selected || !info || selectedHidden) return [];
    if (info.type === mapDocument.OBJECT_TYPE.line) {
      const s = lineShape(model, selected);
      if (!s) return [];
      const encoding = "reason" in s ? s.reason : null;
      const joinReason: ShapeReason | null = "reason" in s ? s.reason : s.parts > 1 ? "multi-part" : s.closed ? "closed" : null;
      const split = splitChange(model, current, selected, opFocus && opFocus.ring === 0 ? opFocus.index : null, "00000000-0000-7000-8000-000000000000");
      // *Snap ends* on an added line (G28): its reason computed now (`no-target` when no end would move).
      const snap = "added" in selected ? snapEndsChange(model, current, selected) : null;
      return [
        { id: "reverse", reason: encoding, onClick: reverse },
        { id: "split", reason: split && "reason" in split ? split.reason : null, onClick: splitAtNode },
        { id: "join", reason: joinReason, pressed: armed?.kind === "join", onClick: () => armOp("join") },
        ...("added" in selected ? [{ id: "snap-ends" as const, reason: snap && "reason" in snap ? snap.reason : null, onClick: snapEnds }] : []),
      ];
    }
    if (info.type === mapDocument.OBJECT_TYPE.area) {
      const s = areaRings(model, selected);
      const holes = s && !("reason" in s) ? s.holes : 0;
      const rm = holes > 0 ? removeHoleChange(model, current, selected, opFocus ? opFocus.ring : null) : null;
      return [
        { id: "cut-hole", reason: null, pressed: armed?.kind === "hole", onClick: () => armOp("hole") },
        ...(holes > 0 ? [{ id: "remove-hole" as const, reason: rm && "reason" in rm ? rm.reason : null, onClick: removeHole }] : []),
      ];
    }
    return [];
  }, [model, selected, info, selectedHidden, current, opFocus, armed?.kind, reverse, splitAtNode, removeHole, armOp, snapEnds]);

  // ─── GPS tracks: convert (§13 "GPS tracks: convert", G26) ──
  const convertRows = tracks.selection;
  const convert = useTrackConvert({
    open: convertOpen, rows: convertRows, pinned, patch: current, unitsPerMm: model?.unitsPerMm ?? null, documentHash: hash,
    doc: model?.doc ?? null,
  });
  // Closed when drawing becomes disabled or nothing is left to convert.
  useEffect(() => {
    if (convertOpen && (!canDraw || convertRows.length === 0)) setConvertOpen(false);
  }, [convertOpen, canDraw, convertRows.length]);
  const openConvert = useCallback(() => {
    if (!canDraw || convertRows.length === 0) return;
    armDropping("V"); // a drawing in progress is dropped, its draft with it
    setConvertOpen(true);
  }, [canDraw, convertRows.length, armDropping]);
  const closeConvert = useCallback(() => {
    setConvertOpen(false);
    keepWaiting();
  }, [keepWaiting]);
  /** *Convert*: one `applyChange` of every add (the symbol's first use with it) and the marks, one undo entry. */
  const applyConvert = useCallback(() => {
    const r = convert.result;
    if (!r || writingRef.current) return;
    setDraft({ ops: r.plan.ops, ...(r.change.putSymbols ? { symbols: r.change.putSymbols } : {}), waitFor: null });
    const marks = r.plan.marks, before = r.plan.before;
    if (!commit(r.change, true, { after: () => tracks.mark(marks), undo: () => tracks.mark(before) })) return;
    setConvertOpen(false);
    tracks.clearSelection();
  }, [convert.result, commit, tracks]);

  // ─── The binding ──
  const select = useCallback((ref: MapObjectRef | null, refs: MapObjectRef[]) => { setSelected(ref); setStack(refs); }, []);
  const nodesBinding = useMemo(() => (tool !== "N" ? null : mapNodesBinding({
    hit,
    clickSeq,
    onSelect: select,
    rings: nodePath?.rings ?? null,
    canPress: !writing,
    maxNodes: MAP_NODES_MAX,
    onPress: () => { pressPatch.current = patchRef.current; },
    focus,
    gesture: nodeGesture,
    snap: snapNode,
    onDraft: (ring, vertices) => {
      const op = ringOp(ring, vertices);
      setDraft(op ? { ops: [op], waitFor: null } : null);
    },
    // A press's release goes through the stale check; a double-click's insert has no press of its own.
    onCommit: (ring, vertices, index, pressed) => (pressed ? releaseNodes(ring, vertices, index) : commitNodes(ring, vertices, index)),
    onCancel: () => setDraft((d) => (d?.waitFor != null ? d : null)),
    onFocus: setFocus,
  })), [tool, hit, select, nodePath, writing, focus, snapNode, ringOp, commitNodes, releaseNodes, setFocus]);
  const selectBinding = useMemo(() => mapSelectBinding({
    hit,
    canMove,
    pressOn: (pt, tol) => !!model && !!selected && hitsObject(model, selected, pt, tol),
    gesture,
    clickSeq,
    onSelect: select,
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
  }), [hit, canMove, model, selected, commit, select]);
  // An armed line or area operation takes the clicks (§13 "Line and area operations"): Join's pick, Cut hole's ring.
  const joinBinding = useMemo(() => (armed?.kind !== "join" ? null : mapPickBinding({ hit, clickSeq, onPick: onJoinPick })), [armed?.kind, hit, onJoinPick]);
  const holeBinding = useMemo(() => (armed?.kind !== "hole" ? null : mapDrawBinding({
    gesture: drawGesture,
    poly: poly ?? { kind: "map_area", vertices: [] },
    hover: drawHover,
    onHover: onDrawHover,
    onPoly: (next) => { setPoly(next); holeDraft(next); },
    onDone: finishHole,
    onCancel: disarm,
    snap: drawSnap,
    canClose: () => !writingRef.current,
  })), [armed?.kind, poly, drawHover, onDrawHover, holeDraft, finishHole, disarm, drawSnap]);
  // `T` on map lines (G32): the selected line's splittable nodes; a click on one is *Split at node* there.
  // One kind's nodes at a time: while GPS tracks are the tool's (ticked, visible), the line's are not drawn.
  const trackNodes = tool === "T" && tracks.selection.some((r) => r.visible && r.geometry);
  const splitLine = useMemo(() => {
    if (tool !== "T" || trackNodes || !selected || !model || selectedHidden) return null;
    const n = nodesOf(model, selected, { canEdit: canPatch, correctionsOn, coords: draftCoords });
    if (!n || !("path" in n) || n.path.area || n.path.rings.length !== 1) return null;
    return { vertices: n.path.rings[0].vertices, closed: n.path.rings[0].closed };
  }, [tool, trackNodes, selected, model, selectedHidden, canPatch, correctionsOn, draftCoords]);
  const clearTrackSelection = tracks.clearSelection;
  // A map selection made in T by any path (a click, Tab, a correction row) drops the GPS track selection.
  useEffect(() => { if (tool === "T" && selected) clearTrackSelection(); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  /** `T`'s click off the GPS tracks selects the topmost line under it; on no line it deselects, unless tracks are picked. */
  const selectLine = useCallback((_ref: MapObjectRef | null, refs: MapObjectRef[]) => {
    const lines = model ? refs.filter((r) => { const i = model.indexOf(r); return i !== null && model.doc.attrs.type[i] === mapDocument.OBJECT_TYPE.line; }) : [];
    if (lines.length > 0) select(lines[0], lines);
    else if (!trackNodes) select(null, []);
  }, [model, select, trackNodes]);
  const splitBinding = useMemo(() => (tool !== "T" ? null : mapSplitBinding({
    hit,
    clickSeq,
    onSelect: selectLine,
    line: splitLine,
    canSplit: canWrite,
    onSplit: (index) => {
      if (!canWrite || !model || !selected || selectedHidden) return;
      runOp(splitChange(model, current, selected, index, newAddId()));
    },
  })), [tool, hit, selectLine, splitLine, canWrite, model, selected, selectedHidden, current, runOp]);
  const tBinding = splitBinding ? mapTBinding(tracks.toolBinding, tracks.hitsTrack, splitBinding, clickSeq) : null;
  const binding = tBinding ?? joinBinding ?? holeBinding ?? pointBinding ?? lineBinding ?? nodesBinding ?? selectBinding;

  const selectedList = useMemo(() => (selected ? [selected] : []), [selected]);
  // The convert panel's preview is drawn with any draft still waiting for its write to be drawn.
  const preview = convertOpen ? convert.preview : null;
  const draftInput = useMemo(() => {
    if (!draft && !preview) return null;
    const ops = [...(draft?.ops ?? []), ...(preview?.ops ?? [])];
    const symbols = draft?.symbols || preview?.symbols ? { ...draft?.symbols, ...preview?.symbols } : undefined;
    return { ops, ...(symbols ? { symbols } : {}) };
  }, [draft, preview]);
  const editor = useMemo<MapViewerEditorProps>(() => ({
    tool: withTrackLayer(binding, tracks.layer),
    viewRequest,
    hideCourse,
    mapObjects: { selected: selectedList, draft: draftInput, onHitTest, onPatchDrawn },
  }), [binding, tracks.layer, viewRequest, hideCourse, selectedList, draftInput, onHitTest, onPatchDrawn]);

  // ─── Keys ──
  const fit = useCallback(() => {
    if (mapDoc) setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, bounds: boundsMm(mapDoc.header) }));
  }, [mapDoc]);
  const toggleHideCourse = useCallback(() => setHideCourse((v) => !v), []);
  const onKey = useCallback((e: KeyboardEvent): boolean => {
    const action = mapKeyAction(e);
    if (!action) return false;
    switch (action.kind) {
      case "tool": armTool(action.tool); return true;
      case "finish": {
        // Enter ends the line or closes the area (or the cut hole's ring) being drawn (§13 "Drawing"), through the
        // flow's minimum.
        if (!poly || !(lineBinding || holeBinding)) return false;
        e.preventDefault();
        const r = polygonStep(poly, { type: "enter" });
        if (r.done) {
          if (holeBinding) finishHole(r.done);
          else finishDrawing(r.done);
        }
        return true;
      }
      case "toggle-overprint": toggleHideCourse(); return true;
      case "fit": fit(); return true;
      case "step": e.preventDefault(); step(action.dir); return true;
      case "hide":
        e.preventDefault();
        // In N a focused node is deleted instead (§13 "Nodes").
        if (tool === "N" && focus) deleteNode();
        else hide();
        return true;
      case "escape":
        // The viewer cancels a drag in flight first (§3); then the focused node, N back to V, the selection; with
        // nothing left, the page leaves fullscreen.
        if (armed) { disarm(); return true; }
        if (poly) { dropDrawing(); return true; }
        if (changing) { setChanging(false); return true; }
        if (attaching) { setAttaching(null); return true; }
        if (convertOpen) { closeConvert(); return true; }
        if (focus) { setFocus(null); return true; }
        if (tool !== "V") { armTool("V"); return true; }
        if (!selected) return false;
        setSelected(null);
        setStack([]);
        return true;
    }
  }, [toggleHideCourse, fit, step, hide, selected, tool, focus, deleteNode, setFocus, armTool, poly, lineBinding, holeBinding, finishDrawing, finishHole, dropDrawing, changing, setChanging, attaching, convertOpen, closeConvert, armed, disarm]);

  // ─── Rail and inspector ──
  const rail = (
    <div data-testid="editor-tool-rail" className="pointer-events-auto relative flex flex-col gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm p-1 self-start">
      {MAP_RAIL.map((key) => {
        const label = t(RAIL_LABEL[key]);
        const off = key === "T" ? !!tOff : isMapDrawTool(key) && !canDraw;
        return (
          <button key={key} type="button" data-testid={`editor-tool-${key}`} aria-pressed={tool === key} title={off ? `${label} — ${key === "T" ? tOff : t("mapDrawOff")}` : label} aria-label={label}
            disabled={off} onClick={() => armTool(key)}
            className={`w-8 h-8 rounded-md text-xs font-semibold flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${tool === key ? "bg-purple-100 text-purple-700" : "text-slate-600 hover:bg-slate-100"}`}>
            {key}
          </button>
        );
      })}
      <div className="h-px bg-slate-200 my-0.5" />
      <button type="button" data-testid="editor-snapping" aria-pressed={snapping} title={t("mapSnapping")} aria-label={t("mapSnapping")} onClick={() => setSnapping((v) => !v)}
        className={`w-8 h-8 rounded-md flex items-center justify-center cursor-pointer ${snapping ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}>
        <svg viewBox="0 0 16 16" className="w-4 h-4" aria-hidden><path d="M4 2v6a4 4 0 0 0 8 0V2M4 5h3M9 5h3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
    </div>
  );
  const inspector = !mapDoc ? (
    <p data-testid="editor-map-none" className="px-2.5 py-2 text-xs text-slate-500">{t("mapNone")}</p>
  ) : (
    <>
      {!canEdit && <p data-testid="editor-map-readonly" className="px-2.5 py-1.5 text-[11px] text-slate-500">{t("mapReadOnly")}</p>}
      {promote.banner}
      {canEdit && !correctionsOn && <p data-testid="editor-map-disabled" className="px-2.5 py-1.5 text-[11px] text-amber-700 bg-amber-50">{t("mapDisabled")}</p>}
      {drawKind && palette && (
        <InspectorSection title={t("mapSymbols")} testId="editor-inspector-map-symbols">
          <SymbolPicker groups={palette} kind={drawKind} query={query} onQuery={setQuery} pressed={chosenItem?.enabled ? chosenKey : null} onPick={pick}
            documentHash={mapDoc.hash} nameId={nameId}
            hint={chosenPut ? { testId: "editor-map-palette-hint", text: t(`mapPaletteHint_${drawKind}` as const) } : { testId: "editor-map-palette-pick", text: t("mapPalettePick") }} />
        </InspectorSection>
      )}
      <InspectorSection title={t("mapObject")} testId="editor-inspector-map-object">
        <MapObjectSection info={info} hidden={selectedHidden} documentHash={mapDoc.hash} nameId={nameId} canWrite={canWrite} onHide={hide} onRestore={restore}
          canChangeSymbol={!!info && kindOfType(info.type) !== null} changing={changing} onChangeSymbol={() => { setAttaching(null); if (armed) disarm(); setChanging(!changing); }}
          picker={changing && info && palette && pickerKind ? (
            <SymbolPicker groups={palette} kind={pickerKind} query={query} onQuery={setQuery} pressed={symbolKey(info.symbol)} onPick={pick}
              documentHash={mapDoc.hash} nameId={nameId} onEscape={() => setChanging(false)} />
          ) : null}
          orientable={selectedOrientable} onRotate={rotate} ops={shapeOps} />
        {armed && (
          <div data-testid={armed.kind === "join" ? "editor-map-join-hint" : "editor-map-hole-hint"} data-reason={armed.reason ?? undefined}
            className="px-2.5 py-1.5 text-[11px] text-purple-800 bg-purple-50 flex flex-col gap-0.5">
            <span>{t(armed.kind === "join" ? "mapJoinHint" : "mapHoleHint")}</span>
            {armed.reason && <span className="text-amber-700">{t(`mapOpReason_${armed.reason}`)}</span>}
          </div>
        )}
        {nodes && !armed && ("path" in nodes
          ? <p data-testid="editor-map-nodes-hint" className="px-2.5 py-1.5 text-[11px] text-slate-500">{t("mapNodesHint")}</p>
          : <p data-testid="editor-map-nodes-none" data-reason={nodes.reason} className="px-2.5 py-1.5 text-[11px] text-slate-500">{t(`mapNodesNone_${nodes.reason}`)}</p>)}
      </InspectorSection>
      <InspectorSection title={t("corrections")} testId="editor-corrections">
        <CorrectionsList rows={rows} selected={selected} enabled={toggling ?? correctionsOn} canWrite={canPatch} busy={toggling !== null}
          onLocate={(r) => locate(r.ref)} onRevert={revert} onEnabled={setCorrectionsOn}
          unresolved={{
            rows: unresolved,
            source: selected && "source" in selected ? selected.source : null,
            canAttach: canWrite,
            canDrop: canPatch && !writing,
            attaching,
            picker: attachingRow && palette && pickerKind ? (
              <SymbolPicker groups={palette} kind={pickerKind} query={query} onQuery={setQuery} pressed={null} onPick={pick}
                documentHash={mapDoc.hash} nameId={nameId} onEscape={() => setAttaching(null)}
                hint={{ testId: "editor-map-palette-attach", text: t("correctionAttachPick") }} />
            ) : null,
            onLocate: locateEntry,
            onAttach: attachEntry,
            onDrop: dropEntry,
          }} />
      </InspectorSection>
      {promote.section && (
        <InspectorSection title={t("promoteSection")} testId="editor-inspector-map-promote">
          {promote.section}
        </InspectorSection>
      )}
      {tracks.panel && (
        <InspectorSection title={t("gpsTracks")} testId="editor-tracks">
          <TracksPanel panel={tracks.panel} convert={{
            open: convertOpen,
            off: !canDraw ? t("mapDrawOff") : convertRows.length === 0 ? t("trackConvertNone") : writing ? t("trackConvertBusy") : null,
            onOpen: openConvert,
            content: (
              <ConvertPanel convert={convert} tracks={convertRows.length} documentHash={mapDoc.hash} nameId={nameId} busy={writing}
                onApply={applyConvert} onCancel={closeConvert} />
            ),
          }} />
        </InspectorSection>
      )}
    </>
  );

  return { editor, rail, inspector, onKey, hideCourse, toggleHideCourse };
}

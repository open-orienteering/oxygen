/**
 * The new course editor (docs/course-editor.md), mounted on
 * `/:nameId/course-editor` for `vector ∧ pinned ∧ map.editor.vector`
 * (`CourseEditorRoute`). One GL canvas (`MapPanel` → `MapViewer` over
 * `VectorMapLayer`) with the shell around it: top bar, tool rail,
 * contextual action bar, inspector, status bar (§2).
 *
 * - Selection is the legacy model (`lib/editor/state.ts`); the viewer
 *   hit-tests the course layer's symbolised shapes (`sharedHitTest`, §5).
 * - Every gesture is one write and one undo entry (`UndoStack`, 50).
 * - Sequence edits are `course.setStructure` with the course's token; the
 *   first save makes start and finish explicit (course-layer.md §6.2).
 *   Control writes are `control.update` with the control's token.
 *   `EditorWrites` applies the G1 client rules (§3); a conflict the user
 *   must see becomes the notice above the inspector.
 * - Autosave: there is no save button; the status bar says saved /
 *   saving / not saved / changed elsewhere.
 *
 * Course mode only (Layout D7, Field D9); the creation tools, gaps,
 * snapping and multi-select are D5's.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ControlDescription, course } from "@oxygen/shared";
import { trpc } from "../../lib/trpc";
import { MapPanel } from "../../components/MapPanel";
import { ControlDescriptionEditor } from "../../components/ControlDescriptionEditor";
import type { EditorDescriptionSuggestion, MapViewerEditorProps } from "../../components/MapViewer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { IOF_SYMBOLS } from "../../iof-symbols";
import { iofSymbolName } from "../../iof-symbol-meta";
import { ocadToIof } from "../../lib/control-description-options";
import {
  buildInventoryView, codesHaveSrr, courseMembership, courselessClassNames, matchCourselessClass,
  nextFreeSrrCode, nextSeriesControlCode, sequenceLegMeters,
} from "../../lib/course-editor";
import { UndoStack } from "../../lib/undo-stack";
import { EditorConflict, EditorWrites, type EditorClient } from "../../lib/editor/write-client";
import { editorReducer, escapeHasWork, initialEditorState } from "../../lib/editor/state";
import { appendSite, insertSite, moveVisit, removeSite, removeVisit, setRole } from "../../lib/editor/structure-edit";
import { displaySequence, effectiveEnds, explicitStructure, insertIndexForLeg, kindOfSites, type SiteRow } from "../../lib/editor/sequence";
import { courseActions } from "./ActionBar";
import { TopBar } from "./TopBar";
import { ToolRail } from "./ToolRail";
import { ChecksSection, Inspector, InspectorSection, InventorySection } from "./Inspector";
import { StatusBar, type SaveState } from "./StatusBar";
import { CourseSection, SelectionSection } from "./modes/CourseMode";

type Pt = { x: number; y: number };
type Structure = course.WireCourseStructure;

/** A conflict the user sees (docs/course-editor.md §3). */
type Notice =
  | { kind: "refresh"; items: string[] | null }
  | { kind: "moved"; controlId: number; mine: Pt; theirs: Pt | null };

export function EditorPage() {
  const { t } = useTranslation("editor");
  const { t: tc, i18n } = useTranslation("courses");
  const isMobile = useMediaQuery("(max-width: 639px)");
  const utils = trpc.useUtils();
  const [searchParams] = useSearchParams();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);

  const [undoStack] = useState(() => new UndoStack(50));
  const [, setHistVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistVersion((v) => v + 1), []);
  const [moveEpoch, setMoveEpoch] = useState(0);
  const [writes] = useState(() => new EditorWrites(utils.client as unknown as EditorClient));
  const client = utils.client;

  const [pendingOps, setPendingOps] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastMovedId, setLastMovedId] = useState<number | null>(null);
  const [radioSwapOffer, setRadioSwapOffer] = useState<{ controlId: number; from: string; to: number; series: string } | null>(null);
  const exhaustedShown = useRef(false);
  const [showExhausted, setShowExhausted] = useState(false);
  const [allocSeriesId, setAllocSeriesId] = useState<string | null>(null);
  const [descControlId, setDescControlId] = useState<number | null>(null);

  // ─── Data ────────────────────────────────────────────────
  const controlList = trpc.control.list.useQuery();
  const seriesAllocation = trpc.controlSeries.allocation.useQuery(undefined, { staleTime: 60_000 });
  const controlCoords = trpc.course.controlCoordinates.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const courses = trpc.course.list.useQuery();
  const classes = trpc.class.list.useQuery();
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY, enabled: !!mapInfo.data });
  const mapScale = mapMetadata.data?.scale ?? null;
  const detail = trpc.course.detail.useQuery(
    { id: state.selectedCourseId ?? 0 },
    { enabled: state.selectedCourseId !== null },
  );

  useEffect(() => { if (courses.data) writes.versions.seedAll("course", courses.data); }, [courses.data, writes]);
  useEffect(() => { if (controlList.data) writes.versions.seedAll("control", controlList.data); }, [controlList.data, writes]);
  useEffect(() => { if (detail.data) writes.versions.seed("course", detail.data.id, detail.data.version); }, [detail.data, writes]);

  const sites: SiteRow[] = useMemo(
    () => (controlCoords.data ?? []).map((c) => ({ id: c.id, code: c.code, status: c.status, mapX: c.mapX, mapY: c.mapY })),
    [controlCoords.data],
  );
  const kindOf = useMemo(() => kindOfSites(sites), [sites]);
  const coordsById = useMemo(() => new Map((controlCoords.data ?? []).map((c) => [c.id, c] as const)), [controlCoords.data]);
  const controlRowsById = useMemo(() => new Map((controlList.data ?? []).map((c) => [c.id, c] as const)), [controlList.data]);
  const selectedCourse = useMemo(
    () => (state.selectedCourseId !== null ? courses.data?.find((c) => c.id === state.selectedCourseId) ?? null : null),
    [state.selectedCourseId, courses.data],
  );
  /** The selected course's structure as stored (or read from its columns), while its detail is current. */
  const structure: Structure | null = detail.data && detail.data.id === state.selectedCourseId ? (detail.data.structure as Structure) : null;
  const rows = useMemo(() => (structure ? displaySequence(structure, sites) : []), [structure, sites]);
  const sequenceIds = useMemo(() => rows.filter((r) => r.kind === "control").map((r) => r.id), [rows]);
  const legMeters = useMemo(() => sequenceLegMeters(rows.map((r) => r.pt), mapScale), [rows, mapScale]);
  const totalMeters = useMemo(() => legMeters.reduce<number>((sum, m) => sum + (m ?? 0), 0), [legMeters]);
  const inventory = useMemo(
    () => buildInventoryView(seriesAllocation.data ?? [], (controlList.data ?? []).map((c) => c.codes)),
    [seriesAllocation.data, controlList.data],
  );
  const activeSeriesId = allocSeriesId !== null && inventory.some((s) => s.seriesId === allocSeriesId) ? allocSeriesId : null;
  const membership = useMemo(() => courseMembership(courses.data ?? []), [courses.data]);

  // ─── Write plumbing ──────────────────────────────────────
  const invalidate = useCallback(() => {
    void utils.course.controlCoordinates.invalidate();
    void utils.control.list.invalidate();
    void utils.course.courseGeometries.invalidate();
    void utils.course.list.invalidate();
    void utils.course.detail.invalidate();
  }, [utils]);

  /** One write (or an undo / redo): pending count, the conflict notice or the error, then a reload. */
  const run = useCallback(async <T,>(op: () => Promise<T>, move?: { controlId: number; mine: Pt }): Promise<T | undefined> => {
    setPendingOps((n) => n + 1);
    setErrorMsg(null);
    try {
      const out = await op();
      setNotice(null);
      return out;
    } catch (e) {
      if (e instanceof EditorConflict) {
        if (e.decision.kind === "moved" && move) setNotice({ kind: "moved", controlId: move.controlId, mine: move.mine, theirs: e.decision.theirs });
        else setNotice({ kind: "refresh", items: e.decision.kind === "refresh" ? e.decision.differing : null });
      } else {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
      return undefined;
    } finally {
      setPendingOps((n) => n - 1);
      invalidate();
    }
  }, [invalidate]);

  /** Push an undo entry for a write that succeeded. */
  const record = useCallback((undo: () => Promise<unknown>, redo: () => Promise<unknown>) => {
    undoStack.push({ undo, redo });
    bumpHistory();
  }, [undoStack, bumpHistory]);

  /** The structure edits start from: the current one with its start and finish explicit. */
  const baseStructure = useCallback((): Structure | null => (structure ? explicitStructure(structure, sites) : null), [structure, sites]);

  /** One sequence edit: `setStructure(next)`, undo writes back the structure it replaced. */
  const applyStructure = useCallback(async (edit: (s: Structure) => Structure): Promise<boolean> => {
    const course = selectedCourse;
    const prev = structure;
    const base = baseStructure();
    if (!course || !prev || !base) return false;
    const next = edit(base);
    const redo = () => writes.setStructure(course.id, next);
    if ((await run(redo)) === undefined) return false;
    record(() => writes.setStructure(course.id, prev), redo);
    return true;
  }, [selectedCourse, structure, baseStructure, writes, run, record]);

  /** Create a control at `pt`; with `insertAt` also into the selected course at that position (one undo entry). */
  const createControl = useCallback(async (pt: Pt, insertAt: number | null) => {
    if (!controlList.data) return;
    const allocation = seriesAllocation.data ?? [];
    const { code, entry } = nextSeriesControlCode(allocation, controlList.data.map((c) => c.codes), activeSeriesId);
    if (!entry && allocation.length > 0 && !exhaustedShown.current) {
      exhaustedShown.current = true;
      setShowExhausted(true);
    }
    const created = await run(() => client.control.create.mutate({ codes: String(code), status: 0, xpos: pt.x, ypos: pt.y, autoDescribe: true }));
    if (!created) return;
    const id = created.id;
    if (entry?.type === "srr") await run(() => client.control.upsertConfig.mutate({ controlIds: [id], radioType: "internal_radio" }));
    const course = selectedCourse;
    const base = baseStructure();
    if (insertAt !== null && course && base && structure) {
      const prev = structure;
      const next = insertSite(base, insertAt, id, kindOf);
      if ((await run(() => writes.setStructure(course.id, next))) !== undefined) {
        record(
          async () => { await writes.setStructure(course.id, prev); await writes.deleteControl(id); },
          async () => { await client.control.restore.mutate({ id }); await writes.setStructure(course.id, next); },
        );
      }
    } else {
      record(() => writes.deleteControl(id), () => client.control.restore.mutate({ id }));
    }
    dispatch({ type: "placed", id });
  }, [controlList.data, seriesAllocation.data, activeSeriesId, run, client, selectedCourse, baseStructure, structure, kindOf, writes, record]);

  /** A code-less start / finish (named "Start N" / "Mål N" by the server). */
  const createRoleControl = useCallback(async (pt: Pt, role: "start" | "finish") => {
    const created = await run(() => client.control.create.mutate({ status: role === "start" ? 4 : 5, xpos: pt.x, ypos: pt.y }));
    if (!created) return;
    const id = created.id;
    record(() => writes.deleteControl(id), () => client.control.restore.mutate({ id }));
    dispatch({ type: "placed", id });
  }, [run, client, writes, record]);

  // ─── Gestures (stable: they flow through MapPanel's memo) ─
  const handleMapClick = useCallback((pt: Pt) => {
    setRadioSwapOffer(null);
    dispatch({ type: "map-click", x: pt.x, y: pt.y });
  }, []);

  const handleSelect = useCallback((idStr: string | null) => {
    setRadioSwapOffer(null);
    const id = idStr === null ? null : parseInt(idStr, 10);
    if (id === null || !Number.isNaN(id)) dispatch({ type: "select", id });
  }, []);

  const handleMoveEnd = useCallback((idStr: string, pt: Pt) => {
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id)) return;
    const prev = coordsById.get(id);
    dispatch({ type: "select", id });
    setLastMovedId(id);
    void (async () => {
      const from = prev ? { x: prev.mapX, y: prev.mapY } : undefined;
      const redo = () => writes.updateControl({ id, xpos: pt.x, ypos: pt.y, autoDescribe: true }, from);
      if ((await run(redo, { controlId: id, mine: pt })) === undefined || !prev) return;
      record(() => writes.updateControl({ id, xpos: prev.mapX, ypos: prev.mapY, description: prev.description ?? null }), redo);
    })();
  }, [coordsById, writes, run, record]);

  const handleLabelMoveEnd = useCallback((idStr: string, offset: { dx: number; dy: number }) => {
    const id = parseInt(idStr, 10);
    const course = selectedCourse;
    if (Number.isNaN(id) || !course) return;
    const prev = course.labelOffsets?.[idStr] ?? null;
    dispatch({ type: "select", id });
    void (async () => {
      const redo = () => writes.setLabelOffset(course.id, id, offset);
      if ((await run(redo)) === undefined) return;
      record(() => writes.setLabelOffset(course.id, id, prev), redo);
    })();
  }, [selectedCourse, writes, run, record]);

  const handleLegClick = useCallback((courseName: string, legIndex: number, pt: Pt) => {
    if (!selectedCourse || courseName !== selectedCourse.name) return;
    setRadioSwapOffer(null);
    dispatch({ type: "leg-click", x: pt.x, y: pt.y, insertAt: insertIndexForLeg(rows, legIndex) });
  }, [selectedCourse, rows]);

  const handleDismiss = useCallback(() => {
    setRadioSwapOffer(null);
    dispatch({ type: "escape" });
  }, []);

  // ─── Selection actions ───────────────────────────────────
  const resetLabel = useCallback(() => {
    const course = selectedCourse, id = state.selectedControlId;
    if (!course || id === null) return;
    const prev = course.labelOffsets?.[String(id)] ?? null;
    if (!prev) return;
    void (async () => {
      const redo = () => writes.setLabelOffset(course.id, id, null);
      if ((await run(redo)) === undefined) return;
      record(() => writes.setLabelOffset(course.id, id, prev), redo);
    })();
  }, [selectedCourse, state.selectedControlId, writes, run, record]);

  const handleDelete = useCallback(() => {
    const sel = state.selectedControlId;
    if (sel === null || pendingOps > 0) return;
    const code = coordsById.get(sel)?.code ?? String(sel);
    if (!window.confirm(tc("editor.deleteConfirm", { code }))) return;
    // The server cascades the delete out of every structure; undo puts the structures back.
    const affected = (courses.data ?? []).filter((c) => c.controls.split(";").filter(Boolean).map(Number).includes(sel)
      || c.startControlId === sel || c.finishControlId === sel);
    void (async () => {
      const before = await Promise.all(affected.map((c) => utils.course.detail.fetch({ id: c.id }).then((d) => ({ id: c.id, structure: d.structure as Structure }))));
      const redo = () => writes.deleteControl(sel);
      if ((await run(redo)) === undefined) return;
      record(async () => {
        await client.control.restore.mutate({ id: sel });
        for (const c of before) await writes.setStructure(c.id, c.structure);
      }, redo);
      dispatch({ type: "deleted", id: sel });
    })();
  }, [state.selectedControlId, pendingOps, coordsById, tc, courses.data, utils, writes, run, record, client]);

  const setRadioType = useCallback(async (controlId: number, radioType: "normal" | "internal_radio") => {
    await run(() => client.control.upsertConfig.mutate({ controlIds: [controlId], radioType }));
  }, [client, run]);

  const handleRadio = useCallback(() => {
    const id = state.selectedControlId;
    const control = id !== null ? controlRowsById.get(id) : undefined;
    if (!control) return;
    if ((control.config?.radioType ?? "normal") !== "normal") return void setRadioType(control.id, "normal");
    const allocation = seriesAllocation.data ?? [];
    if (allocation.length === 0 || codesHaveSrr(control.codes, allocation)) return void setRadioType(control.id, "internal_radio");
    const replacement = nextFreeSrrCode(allocation, (controlList.data ?? []).map((c) => c.codes));
    if (replacement) {
      setRadioSwapOffer({ controlId: control.id, from: control.codes, to: replacement.code, series: replacement.seriesName });
      return;
    }
    void setRadioType(control.id, "internal_radio");
  }, [state.selectedControlId, controlRowsById, seriesAllocation.data, controlList.data, setRadioType]);

  const confirmSwap = useCallback(() => {
    const offer = radioSwapOffer;
    if (!offer) return;
    setRadioSwapOffer(null);
    void (async () => {
      if ((await run(() => writes.updateControl({ id: offer.controlId, codes: String(offer.to) }))) === undefined) return;
      await setRadioType(offer.to, "internal_radio");
      dispatch({ type: "select", id: offer.to });
    })();
  }, [radioSwapOffer, run, writes, setRadioType]);

  const declineSwap = useCallback(() => {
    const offer = radioSwapOffer;
    if (!offer) return;
    setRadioSwapOffer(null);
    void setRadioType(offer.controlId, "internal_radio");
  }, [radioSwapOffer, setRadioType]);

  // ─── Descriptions ────────────────────────────────────────
  const descControl = descControlId !== null ? coordsById.get(descControlId) ?? null : null;
  const saveDescription = useCallback((next: ControlDescription | null) => {
    const id = descControlId;
    setDescControlId(null);
    if (id === null) return;
    setLastMovedId((v) => (v === id ? null : v));
    const prev = coordsById.get(id)?.description ?? null;
    void (async () => {
      const redo = () => writes.updateControl({ id, description: next });
      if ((await run(redo)) === undefined) return;
      record(() => writes.updateControl({ id, description: prev }), redo);
    })();
  }, [descControlId, coordsById, writes, run, record]);
  const closeDescription = useCallback(() => setDescControlId(null), []);

  useEffect(() => {
    if (lastMovedId !== null && state.selectedControlId !== lastMovedId) setLastMovedId(null);
  }, [state.selectedControlId, lastMovedId]);
  const selectedCoord = state.selectedControlId !== null ? coordsById.get(state.selectedControlId) ?? null : null;
  const suggestFor = selectedCoord && selectedCoord.id === lastMovedId && !!selectedCoord.description && !state.phantom && descControlId === null
    ? selectedCoord : null;
  const suggestQuery = trpc.control.suggestDescription.useQuery(
    { x: suggestFor?.mapX ?? 0, y: suggestFor?.mapY ?? 0 },
    { enabled: !!suggestFor && !!mapInfo.data, staleTime: Number.POSITIVE_INFINITY },
  );
  const suggestions = useMemo<EditorDescriptionSuggestion[]>(() => {
    const id = suggestFor?.id;
    const top = suggestQuery.data?.candidates?.[0];
    if (id == null || !top) return [];
    const next: ControlDescription = { d: top.d, ...(top.c ? { c: top.c } : {}), ...(top.e ? { e: top.e } : {}), ...(top.f ? { f: top.f } : {}), ...(top.g ? { g: top.g } : {}) };
    const cur = suggestFor?.description;
    if (cur && cur.d === next.d && cur.g === next.g && cur.c === next.c && cur.f === next.f && cur.e === next.e) return [];
    const iofD = ocadToIof("d", top.d);
    if (!iofD) return [];
    const parts = (["c", "d", "e", "f", "g"] as const).flatMap((col) => {
      const v = top[col];
      const iof = v ? ocadToIof(col, v) : null;
      return iof ? [iofSymbolName(iof, i18n.language)] : [];
    });
    const iofG = top.g ? ocadToIof("g", top.g) : null;
    const prev = suggestFor?.description ?? null;
    return [{
      id: String(top.isom),
      label: tc("editor.suggestedSingle", { label: parts.join(" · ") }),
      symbolSvg: IOF_SYMBOLS[iofD] ?? null,
      sideSvg: iofG ? IOF_SYMBOLS[iofG] ?? null : null,
      onApply: () => {
        setLastMovedId(null);
        void (async () => {
          const redo = () => writes.updateControl({ id, description: next });
          if ((await run(redo)) === undefined) return;
          record(() => writes.updateControl({ id, description: prev }), redo);
        })();
      },
    }];
  }, [suggestFor, suggestQuery.data, i18n.language, tc, writes, run, record]);

  // ─── The action bar ──────────────────────────────────────
  const ends = useMemo(() => (structure ? effectiveEnds(structure, sites) : { start: null, finish: null }), [structure, sites]);
  const contextActions = useMemo(() => {
    const sel = state.selectedControlId;
    const coord = sel !== null ? coordsById.get(sel) : undefined;
    const role = coord ? kindOf(coord.id) : "control";
    return courseActions(
      {
        phantom: state.phantom ? { insertAt: state.phantom.insertAt } : null,
        selected: coord ? {
          id: coord.id,
          role,
          onCourse: sequenceIds.includes(coord.id),
          otherRole: role === "start" ? ends.start !== coord.id : role === "finish" ? ends.finish !== coord.id : false,
          hasLabelOffset: !!selectedCourse?.labelOffsets?.[String(coord.id)],
          radioOn: (controlRowsById.get(coord.id)?.config?.radioType ?? "normal") !== "normal",
          swapOffer: radioSwapOffer?.controlId === coord.id,
        } : null,
        course: selectedCourse && structure ? selectedCourse.name : null,
        codesReady: !!controlList.data,
        busy: pendingOps > 0,
      },
      {
        insert: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, p.insertAt); },
        addToCourse: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, sequenceIds.length); },
        add: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, null); },
        addStart: () => { const p = state.phantom; if (p) void createRoleControl({ x: p.x, y: p.y }, "start"); },
        addFinish: () => { const p = state.phantom; if (p) void createRoleControl({ x: p.x, y: p.y }, "finish"); },
        useAsRole: (r) => { if (sel !== null) void applyStructure((s) => setRole(s, r, sel, kindOf)); },
        append: () => { if (sel !== null) void applyStructure((s) => appendSite(s, sel, kindOf)); },
        removeFromCourse: () => { if (sel !== null) void applyStructure((s) => removeSite(s, sel)); },
        resetLabel,
        radio: handleRadio,
        confirmSwap,
        declineSwap,
        description: () => { if (sel !== null) setDescControlId(sel); },
        delete: handleDelete,
      },
      (key, opts) => tc(key as "editor.actionAdd", opts),
    );
  }, [state.selectedControlId, state.phantom, coordsById, kindOf, sequenceIds, ends, selectedCourse, structure, controlRowsById,
    radioSwapOffer, controlList.data, pendingOps, createControl, createRoleControl, applyStructure, resetLabel, handleRadio,
    confirmSwap, declineSwap, handleDelete, tc]);

  const contextInfo = useMemo(() => {
    const sel = state.selectedControlId;
    if (sel === null) return null;
    if (radioSwapOffer?.controlId === sel) return tc("radioSwapConfirm", { from: radioSwapOffer.from, to: radioSwapOffer.to, series: radioSwapOffer.series });
    const names = membership.get(sel) ?? [];
    const others = selectedCourse ? names.filter((n) => n !== selectedCourse.name) : names;
    return others.length > 0 ? tc("editor.alsoIn", { names: others.join(", ") }) : null;
  }, [state.selectedControlId, radioSwapOffer, membership, selectedCourse, tc]);

  const moveWarnings = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, names] of membership) {
      const others = selectedCourse ? names.filter((n) => n !== selectedCourse.name) : names;
      if (others.length > 0) m.set(String(id), tc("editor.affects", { names: others.join(", ") }));
    }
    return m;
  }, [membership, selectedCourse, tc]);

  const srrBadge = useMemo(() => {
    if (!selectedCoord) return null;
    const e = (seriesAllocation.data ?? []).find((x) => x.code === Number(selectedCoord.code) && x.type === "srr");
    return e ? { label: tc("editor.srrBadge"), title: e.seriesName } : null;
  }, [selectedCoord, seriesAllocation.data, tc]);
  const radioOn = selectedCoord ? (controlRowsById.get(selectedCoord.id)?.config?.radioType ?? "normal") !== "normal" : false;

  const courseView = state.view === "course";
  const courseControlIds = useMemo(() => new Set(sequenceIds.map(String)), [sequenceIds]);
  const editor: MapViewerEditorProps = useMemo(() => ({
    selectedControlId: state.selectedControlId !== null ? String(state.selectedControlId) : null,
    phantom: state.phantom ? { x: state.phantom.x, y: state.phantom.y } : null,
    contextActions,
    contextInfo,
    contextBadge: srrBadge,
    contextRadioBadge: radioOn ? { label: tc("editor.radioBadge") } : null,
    suggestions,
    suggestionsHeading: tc("editor.suggestedHeading"),
    courseControlIds,
    fadeNonCourse: courseView && !!selectedCourse,
    moveWarnings,
    moveEpoch,
    onMapClick: handleMapClick,
    onMoveEnd: handleMoveEnd,
    onLabelMoveEnd: handleLabelMoveEnd,
    onSelect: handleSelect,
    onDismiss: handleDismiss,
    sharedHitTest: true,
    actionLayout: "bar",
    ...(selectedCourse && courseView ? { onLegClick: handleLegClick } : {}),
  }), [state.selectedControlId, state.phantom, contextActions, contextInfo, srrBadge, radioOn, suggestions, tc, courseControlIds,
    courseView, selectedCourse, moveWarnings, moveEpoch, handleMapClick, handleMoveEnd, handleLabelMoveEnd, handleSelect,
    handleDismiss, handleLegClick]);

  // ─── Undo / redo, keyboard, deep links ───────────────────
  const runUndo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => { await undoStack.undo(); bumpHistory(); });
  }, [run, undoStack, bumpHistory]);
  const runRedo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => { await undoStack.redo(); bumpHistory(); });
  }, [run, undoStack, bumpHistory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (descControlId !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) runRedo(); else runUndo();
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        runRedo();
      } else if (e.key === "Escape") {
        // The cascade first; with nothing left, Esc leaves fullscreen (MapPanel holds the Keyboard Lock).
        if (!escapeHasWork(state) && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else { setRadioSwapOffer(null); dispatch({ type: "escape" }); }
      } else if ((e.key === "h" || e.key === "H") && !mod && !e.altKey) {
        dispatch({ type: "toggle-hide-others" });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [descControlId, runUndo, runRedo, state, handleDelete]);

  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current) return;
    const courseParam = searchParams.get("course"), controlParam = searchParams.get("control");
    if (!courseParam && !controlParam) { deepLinkDone.current = true; return; }
    if ((courseParam && !courses.data) || (controlParam && !controlCoords.data)) return;
    deepLinkDone.current = true;
    const courseId = courseParam ? parseInt(courseParam, 10) : NaN;
    if (courses.data?.some((c) => c.id === courseId)) dispatch({ type: "select-course", id: courseId });
    const controlId = controlParam ? parseInt(controlParam, 10) : NaN;
    if (controlCoords.data?.some((c) => c.id === controlId)) dispatch({ type: "select", id: controlId });
  }, [searchParams, courses.data, controlCoords.data]);

  // ─── Course-level writes from the inspector ──────────────
  const versions = writes.versions;
  const handleCreateCourse = useCallback((name: string) => {
    void (async () => {
      // Not undoable (no course.restore); the Courses page deletes courses.
      const created = await run(() => client.course.create.mutate({ name, linkClassId: matchCourselessClass(name, classes.data ?? []) ?? undefined }));
      if (!created) return;
      versions.seed("course", created.id, created.version);
      void utils.class.list.invalidate();
      dispatch({ type: "select-course", id: created.id });
    })();
  }, [run, client, classes.data, versions, utils]);

  const handleClone = useCallback((name: string) => {
    if (!selectedCourse) return;
    void (async () => {
      const cloned = await run(() => client.course.clone.mutate({ id: selectedCourse.id, name }));
      if (!cloned) return;
      versions.seed("course", cloned.id, cloned.version);
      dispatch({ type: "select-course", id: cloned.id });
    })();
  }, [selectedCourse, run, client, versions]);

  const handleEditCode = useCallback((id: number, current: string, nextRaw: string) => {
    const next = nextRaw.trim();
    if (!next || next === current) return;
    const first = parseInt(next.split(";")[0] ?? "", 10);
    const publicNew = Number.isFinite(first) && first > 0 ? first : id;
    const currentCodes = controlRowsById.get(id)?.codes ?? current;
    void (async () => {
      if ((await run(() => writes.updateControl({ id, codes: next }))) === undefined) return;
      // After the edit the control's public id is the new first code; after an undo the old one again.
      record(() => writes.updateControl({ id: publicNew, codes: currentCodes }), () => writes.updateControl({ id, codes: next }));
      dispatch({ type: "select", id: publicNew });
    })();
  }, [controlRowsById, writes, run, record]);

  const cutsQuery = trpc.course.getOverprintCuts.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const setCuts = trpc.course.setOverprintCuts.useMutation({
    onSuccess: async () => {
      await cutsQuery.refetch();
      await utils.course.geometry.invalidate();
      await utils.course.list.invalidate();
    },
  });
  const cutsEnabled = cutsQuery.data?.enabled !== false;

  // ─── Chrome ──────────────────────────────────────────────
  const canUndo = undoStack.canUndo, canRedo = undoStack.canRedo;
  const courseOptions = useMemo(() => (courses.data ?? []).map((c) => ({ id: c.id, name: c.name })), [courses.data]);
  const toolbar = (
    <TopBar
      courses={courseOptions}
      selectedCourseId={state.selectedCourseId}
      onSelectCourse={(id) => dispatch({ type: "select-course", id })}
      view={state.view}
      onView={(view) => dispatch({ type: "view", view })}
      mode={state.mode}
      onMode={(mode) => dispatch({ type: "mode", mode })}
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={runUndo}
      onRedo={runRedo}
      hideOthers={state.hideOthers}
      onToggleHideOthers={() => dispatch({ type: "toggle-hide-others" })}
      cutsEnabled={cutsEnabled}
      cutsBusy={setCuts.isPending || cutsQuery.isLoading}
      onToggleCuts={() => setCuts.mutate({ enabled: !cutsEnabled })}
    />
  );

  const save: SaveState = pendingOps > 0 ? "saving" : notice ? "conflict" : errorMsg ? "error" : "saved";
  const suggestionsForNew = useMemo(
    () => courselessClassNames(classes.data ?? [], (courses.data ?? []).map((c) => c.name)),
    [classes.data, courses.data],
  );
  const radioIds = useMemo(
    () => new Set((controlList.data ?? []).filter((c) => (c.config?.radioType ?? "normal") !== "normal").map((c) => c.id)),
    [controlList.data],
  );
  const selectedInfo = selectedCoord ? {
    code: selectedCoord.code,
    role: kindOf(selectedCoord.id),
    x: selectedCoord.mapX,
    y: selectedCoord.mapY,
    description: selectedCoord.description ? describe(selectedCoord.description, i18n.language) : null,
    alsoIn: (membership.get(selectedCoord.id) ?? []).filter((n) => n !== selectedCourse?.name),
    badges: [
      ...(srrBadge ? [{ label: srrBadge.label, title: srrBadge.title, testId: "editor-toolbar-srr" }] : []),
      ...(radioOn ? [{ label: tc("editor.radioBadge"), testId: "editor-selection-radio" }] : []),
    ],
  } : null;

  const overlay = (
    <div className="flex gap-2 h-full min-h-0 items-stretch">
      <ToolRail />
      <div className="flex flex-col gap-2 min-h-0 h-full">
        {notice && (
          <div data-testid="editor-conflict" data-kind={notice.kind} className="pointer-events-auto w-64 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2 shadow-sm">
            {notice.kind === "refresh" ? (
              <p>{notice.items?.length ? t("conflictRefreshItems", { items: notice.items.join(", ") }) : t("conflictRefresh")}</p>
            ) : (
              <p>{notice.theirs ? t("conflictMoved", { x: notice.theirs.x.toFixed(1), y: notice.theirs.y.toFixed(1) }) : t("conflictRefresh")}</p>
            )}
            <div className="flex gap-1.5 mt-1.5">
              {notice.kind === "moved" && (
                <button type="button" data-testid="editor-conflict-keep-mine" className="px-2 py-0.5 rounded bg-amber-600 text-white cursor-pointer"
                  onClick={() => {
                    const n = notice;
                    void run(() => writes.updateControl({ id: n.controlId, xpos: n.mine.x, ypos: n.mine.y }));
                  }}>
                  {t("keepMine")}
                </button>
              )}
              <button type="button" data-testid="editor-conflict-dismiss" className="px-2 py-0.5 rounded border border-amber-300 cursor-pointer"
                onClick={() => { setNotice(null); setMoveEpoch((v) => v + 1); }}>
                {notice.kind === "moved" ? t("keepTheirs") : t("dismiss")}
              </button>
            </div>
          </div>
        )}
        <Inspector>
          <InspectorSection title={t("sequence")} testId="editor-inspector-course" aside={selectedCourse?.name}>
            <CourseSection
              course={selectedCourse && structure ? { id: selectedCourse.id, name: selectedCourse.name, orderMode: structure.orderMode } : null}
              rows={rows}
              legMeters={legMeters}
              totalMeters={totalMeters}
              suggestions={suggestionsForNew}
              onCreate={handleCreateCourse}
              onClone={handleClone}
              onOrderMode={(mode) => void applyStructure((s) => ({ ...s, orderMode: mode }))}
              onMove={(from, to) => void applyStructure((s) => moveVisit(s, from, to, kindOf))}
              onRemove={(seqIndex) => void applyStructure((s) => removeVisit(s, seqIndex, kindOf))}
              onEditCode={handleEditCode}
              onSelectRow={(id) => dispatch({ type: "select", id })}
              selectedControlId={state.selectedControlId}
              radioIds={radioIds}
            />
          </InspectorSection>
          <InspectorSection title={t("selection")} testId="editor-inspector-selection">
            <SelectionSection selected={selectedInfo} />
          </InspectorSection>
          <InventorySection inventory={inventory} activeSeriesId={activeSeriesId} onSeries={setAllocSeriesId} />
          <ChecksSection />
        </Inspector>
        <div className="mt-auto flex flex-col gap-1">
          {showExhausted && <span data-testid="series-exhausted" className="pointer-events-auto w-fit text-[11px] text-amber-700 bg-white/95 rounded px-1.5">{tc("seriesExhausted")}</span>}
          {errorMsg && <span data-testid="editor-error" className="pointer-events-auto w-64 text-[11px] text-red-600 bg-white/95 rounded px-1.5">{errorMsg}</span>}
          <StatusBar controls={selectedCourse ? sequenceIds.length : null} lengthM={selectedCourse ? totalMeters : null} scale={mapScale} save={save} />
        </div>
      </div>
    </div>
  );

  return (
    <div data-testid="editor-page" className="h-[calc(100dvh-8rem)] sm:h-[calc(100dvh-200px)] min-h-[420px]">
      <div className="h-full bg-white rounded-xl border border-slate-200 overflow-hidden">
        <MapPanel
          fillContainer
          fitToControls
          showMapInfo
          filterMode={state.hideOthers && selectedCourse && courseView ? "course" : "all"}
          defaultShowDescriptions={!isMobile}
          descriptionsAllControls
          toolbar={toolbar}
          mapOverlay={overlay}
          fullscreenOverlay={descControl ? (
            <ControlDescriptionEditor controlCode={descControl.code} initial={descControl.description} onSave={saveDescription} onCancel={closeDescription} />
          ) : null}
          editor={editor}
          highlightCourseName={courseView ? selectedCourse?.name : undefined}
        />
      </div>
    </div>
  );
}

/** A one-line description summary for the inspector: the column-D symbol's name (+ G). */
function describe(d: ControlDescription, lang: string): string {
  const parts = (["c", "d", "e", "g"] as const).flatMap((col) => {
    const v = d[col];
    const iof = v ? ocadToIof(col, v) : null;
    return iof ? [iofSymbolName(iof, lang)] : [];
  });
  return parts.join(" · ");
}

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
 * Course mode only (Layout D7, Field D9). The tools (§6: the armed
 * `S` / `K` / `M`, `A` areas, `T` text, `G` gaps, snapping, Shift-click /
 * lasso multi-select) and course objects (§7) are D5's: each tool is a
 * viewer binding (`tools/bindings.ts`) built here from the state.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ControlDescription, course } from "@oxygen/shared";
import { trpc } from "../../lib/trpc";
import { MapPanel } from "../../components/MapPanel";
import { ControlDescriptionEditor } from "../../components/ControlDescriptionEditor";
import type { EditorDescriptionSuggestion, EditorToolBinding, MapViewerEditorProps, ToolPointer } from "../../components/MapViewer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { IOF_SYMBOLS } from "../../iof-symbols";
import { iofSymbolName } from "../../iof-symbol-meta";
import { ocadToIof } from "../../lib/control-description-options";
import {
  buildInventoryView, codesHaveSrr, courseMembership, courselessClassNames, matchCourselessClass,
  nextFreeSrrCode, nextSeriesControlCode, sequenceLegMeters,
} from "../../lib/course-editor";
import { UndoStack } from "../../lib/undo-stack";
import { useMapDocument } from "../../lib/map-document-cache";
import { courseObjectsForView } from "../../lib/course-layer-request";
import { snapIndexForDocument } from "../../lib/editor/snap";
import { EditorConflict, EditorWrites, type EditorClient } from "../../lib/editor/write-client";
import { areaTool, editorReducer, escapeHasWork, initialEditorState, type EditorTool } from "../../lib/editor/state";
import { appendSite, insertSite, moveVisit, removeSite, removeVisit, setLegGaps, setNumberHidden, setRole, type KindOf } from "../../lib/editor/structure-edit";
import { displaySequence, effectiveEnds, explicitStructure, insertIndexForLeg, kindOfSites, type SiteRow } from "../../lib/editor/sequence";
import { courseActions } from "./ActionBar";
import { TopBar } from "./TopBar";
import { ToolRail, type AreaChoice } from "./ToolRail";
import { afterPlaced, afterUndo, armPlacement, ghostInfo, switchTool, type PlacementState, type PlacementTool } from "./tools/placement";
import { tonerSaverHull, type AreaKind } from "./tools/polygon";
import { mergeCircleGaps, mergeLegGaps, type AngularGap, type FractionGap } from "./tools/gaps";
import { areaBinding, gapBinding, placeBinding, selectBinding, textBinding, type GapTarget, type Gesture } from "./tools/bindings";
import { ObjectSection } from "./modes/ObjectSection";
import { ChecksSection, Inspector, InspectorSection, InventorySection } from "./Inspector";
import { StatusBar, type SaveState } from "./StatusBar";
import { CourseSection, MultiSection, SelectionSection } from "./modes/CourseMode";

type Pt = { x: number; y: number };
type Structure = course.WireCourseStructure;
type CourseObject = course.CourseObject;

/** The toner saver's margin around the course, paper mm (§7). */
const TONER_MARGIN_MM = 10;
const NO_DRAFTS: CourseObject[] = [];
/** New map text: size on paper (§7). */
const TEXT_SIZE_MM = 4;

/** Props a new object of each drawn kind starts with (§7). */
function defaultProps(kind: AreaKind): CourseObject["props"] {
  return kind === "filter_region" ? { mode: "hide", symbols: [] } : {};
}

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
  const { nameId } = useParams<{ nameId: string }>();
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

  const objectList = trpc.courseObject.list.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const documentHash = mapMetadata.data?.documentHash ?? null;
  const { state: docState } = useMapDocument(documentHash, nameId ?? null);
  const mapDoc = docState.status === "ready" ? docState.doc : null;
  /** The layer's derivation and symbol sizes (the viewer reports them): ghost size, effective gaps. */
  const [courseInfo, setCourseInfo] = useState<Parameters<NonNullable<MapViewerEditorProps["onCourseInfo"]>>[0]>(null);

  useEffect(() => { if (objectList.data) writes.versions.seedAll("object", objectList.data); }, [objectList.data, writes]);
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
  /**
   * The structure this client last wrote, until the course's detail catches up with it: placements
   * follow each other faster than the refetch (§6.1), so each one builds on its predecessor's result.
   */
  const localStructure = useRef<{ courseId: number; structure: Structure; version: string } | null>(null);
  const [, setLocalEpoch] = useState(0);
  /** The selected course's structure as stored (or read from its columns), while its detail is current. */
  const detailStructure: Structure | null = detail.data && detail.data.id === state.selectedCourseId ? (detail.data.structure as Structure) : null;
  const local = localStructure.current;
  const structure: Structure | null = local && local.courseId === state.selectedCourseId && detailStructure && BigInt(detail.data!.version) < BigInt(local.version)
    ? local.structure
    : detailStructure;
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
    // Course objects are cached until reload in MapPanel: every write invalidates them (course-layer.md §8.3).
    void utils.courseObject.list.invalidate();
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
    const entry = { undo, redo };
    undoStack.push(entry);
    bumpHistory();
    return entry;
  }, [undoStack, bumpHistory]);

  // Sites this client created since the last refetch: their kind, position and code, for the writes and the
  // ghost that follow before `controlCoordinates` / `control.list` have them (§6.1).
  const created = useRef(new Map<number, { kind: "control" | "start" | "finish"; pt: Pt; code: number | null }>());
  useEffect(() => {
    if (pendingOps === 0) created.current.clear();
  }, [controlCoords.data, controlList.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const kindOfLatest: KindOf = useCallback((id: number) => created.current.get(id)?.kind ?? kindOf(id), [kindOf]);

  // The latest values for writes queued behind each other (a chain of placements runs one at a time).
  const latest = useRef({ detailStructure, detailVersion: detail.data?.version ?? null, selectedCourse, sites, kindOf: kindOfLatest });
  latest.current = { detailStructure, detailVersion: detail.data?.version ?? null, selectedCourse, sites, kindOf: kindOfLatest };

  /**
   * The structure as of now, read from refs: the one this client wrote last unless the course's detail
   * already holds a newer one. A queued placement can run before React re-renders after its predecessor.
   */
  const currentStructure = useCallback((): Structure | null => {
    const { detailStructure: d, detailVersion, selectedCourse: course } = latest.current;
    const mine = localStructure.current;
    if (mine && course && mine.courseId === course.id && d && detailVersion !== null && BigInt(detailVersion) < BigInt(mine.version)) return mine.structure;
    return d;
  }, []);

  /** The structure edits start from: the current one with its start and finish explicit. */
  const baseStructure = useCallback((): Structure | null => {
    const s = currentStructure();
    return s ? explicitStructure(s, latest.current.sites) : null;
  }, [currentStructure]);

  /** `setStructure`, remembering the result as the local structure (every structure write and its undo / redo). */
  const writeStructure = useCallback(async (courseId: number, next: Structure) => {
    const res = await writes.setStructure(courseId, next);
    localStructure.current = { courseId, structure: next, version: res.version };
    setLocalEpoch((v) => v + 1);
    return res;
  }, [writes]);

  /** One sequence edit: `setStructure(next)`, undo writes back the structure it replaced. */
  const applyStructure = useCallback(async (edit: (s: Structure) => Structure): Promise<boolean> => {
    const course = latest.current.selectedCourse;
    const prev = currentStructure();
    const base = baseStructure();
    if (!course || !prev || !base) return false;
    const next = edit(base);
    const redo = () => writeStructure(course.id, next);
    if ((await run(redo)) === undefined) return false;
    record(() => writeStructure(course.id, prev), redo);
    return true;
  }, [currentStructure, baseStructure, writeStructure, run, record]);

  /**
   * Create a site at `pt` — a control (code from the club allocation; SRR codes get radio) or a code-less
   * start / finish — and, with a course, write `edit(base, id)` into its structure: one undo entry (§4, §6.1).
   */
  const createSite = useCallback(async (pt: Pt, kind: "control" | "start" | "finish", edit: ((s: Structure, id: number) => Structure) | null): Promise<number | null> => {
    let code: number | null = null;
    let srr = false;
    if (kind === "control") {
      if (!controlList.data) return null;
      const allocation = seriesAllocation.data ?? [];
      const used = [...controlList.data.map((c) => c.codes), ...[...created.current.values()].flatMap((c) => (c.code !== null ? [String(c.code)] : []))];
      const next = nextSeriesControlCode(allocation, used, activeSeriesId);
      if (!next.entry && allocation.length > 0 && !exhaustedShown.current) {
        exhaustedShown.current = true;
        setShowExhausted(true);
      }
      code = next.code;
      srr = next.entry?.type === "srr";
    }
    const made = await run(() => (kind === "control"
      ? client.control.create.mutate({ codes: String(code), status: 0, xpos: pt.x, ypos: pt.y, autoDescribe: true })
      : client.control.create.mutate({ status: kind === "start" ? 4 : 5, xpos: pt.x, ypos: pt.y })));
    if (!made) return null;
    const id = made.id;
    created.current.set(id, { kind, pt, code });
    if (srr) await run(() => client.control.upsertConfig.mutate({ controlIds: [id], radioType: "internal_radio" }));
    const course = latest.current.selectedCourse;
    const prev = currentStructure();
    const base = baseStructure();
    if (edit && course && base && prev) {
      const next = edit(base, id);
      if ((await run(() => writeStructure(course.id, next))) !== undefined) {
        record(
          async () => { await writeStructure(course.id, prev); await writes.deleteControl(id); },
          async () => { await client.control.restore.mutate({ id }); await writeStructure(course.id, next); },
        );
        return id;
      }
    }
    record(() => writes.deleteControl(id), () => client.control.restore.mutate({ id }));
    return id;
  }, [controlList.data, seriesAllocation.data, activeSeriesId, run, client, currentStructure, baseStructure, writeStructure, writes, record]);

  /** Create a control at `pt`; with `insertAt` also into the selected course at that position (one undo entry). */
  const createControl = useCallback(async (pt: Pt, insertAt: number | null) => {
    const id = await createSite(pt, "control", insertAt !== null ? (s, newId) => insertSite(s, insertAt, newId, kindOfLatest) : null);
    if (id !== null) dispatch({ type: "placed", id });
  }, [createSite, kindOfLatest]);

  /** A code-less start / finish (named "Start N" / "Mål N" by the server). */
  const createRoleControl = useCallback(async (pt: Pt, role: "start" | "finish") => {
    const id = await createSite(pt, role, null);
    if (id !== null) dispatch({ type: "placed", id });
  }, [createSite]);

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

  /** Delete controls (one, or a multi-selection's): confirm, the server cascades; one undo entry restores all. */
  const deleteControls = useCallback((ids: number[]) => {
    if (ids.length === 0 || pendingOps > 0) return;
    const message = ids.length === 1
      ? tc("editor.deleteConfirm", { code: coordsById.get(ids[0])?.code ?? String(ids[0]) })
      : t("bulkDeleteConfirm", { count: ids.length });
    if (!window.confirm(message)) return;
    // The server cascades the delete out of every structure; undo puts the structures back.
    const affected = (courses.data ?? []).filter((c) => ids.some((sel) => c.controls.split(";").filter(Boolean).map(Number).includes(sel)
      || c.startControlId === sel || c.finishControlId === sel));
    void (async () => {
      const before = await Promise.all(affected.map((c) => utils.course.detail.fetch({ id: c.id }).then((d) => ({ id: c.id, structure: d.structure as Structure }))));
      const redo = async () => { for (const id of ids) await writes.deleteControl(id); return true; };
      if ((await run(redo)) === undefined) return;
      record(async () => {
        for (const id of ids) await client.control.restore.mutate({ id });
        for (const c of before) await writeStructure(c.id, c.structure);
      }, redo);
      for (const id of ids) dispatch({ type: "deleted", id });
      dispatch({ type: "set-multi", ids: [] });
    })();
  }, [pendingOps, coordsById, tc, t, courses.data, utils, writes, run, record, client, writeStructure]);
  const handleDelete = useCallback(() => {
    if (state.selectedControlId !== null) deleteControls([state.selectedControlId]);
  }, [state.selectedControlId, deleteControls]);

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

  // ─── Site fields (§6.6): kind, notes, hidden number ─────
  const updateField = useCallback((id: number, patch: { kind?: "control" | "start" | "finish"; notes?: string }, prev: typeof patch) => {
    void (async () => {
      const redo = () => writes.updateControl({ id, ...patch });
      if ((await run(redo)) === undefined) return;
      record(() => writes.updateControl({ id, ...prev }), redo);
    })();
  }, [writes, run, record]);

  // ─── Course objects (§7) ─────────────────────────────────
  const objects = useMemo(() => objectList.data ?? [], [objectList.data]);
  const highlighted = useMemo(() => new Set(state.view === "course" && selectedCourse ? [selectedCourse.name] : []), [state.view, selectedCourse]);
  const objectsInView = useMemo(() => courseObjectsForView(objects, highlighted, courses.data ?? []), [objects, highlighted, courses.data]);
  const selectedObject = state.selectedObjectId !== null ? objects.find((o) => o.id === state.selectedObjectId) ?? null : null;
  /** Geometry being dragged (vertex or body) or drawn, drawn instead of the stored one until the list catches up. */
  const [drafts, setDrafts] = useState<Map<number, CourseObject["geometry"]>>(new Map());
  useEffect(() => { setDrafts((d) => (d.size ? new Map() : d)); }, [objectList.data]);
  const setDraft = useCallback((id: number, geometry: CourseObject["geometry"] | null) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      if (geometry) next.set(id, geometry); else next.delete(id);
      return next;
    });
  }, []);

  /** Create an object: one undo entry (undo deletes it; redo creates it again, under a new id). */
  const createObject = useCallback(async (body: Pick<CourseObject, "kind" | "geometry" | "props" | "scope">): Promise<number | null> => {
    const made = await run(() => writes.createObject(body));
    if (!made) return null;
    const box = { id: made.id };
    record(
      () => writes.deleteObject(box.id),
      async () => { box.id = (await writes.createObject(body)).id; },
    );
    return made.id;
  }, [run, writes, record]);

  const updateObject = useCallback((o: CourseObject, patch: { geometry?: CourseObject["geometry"]; props?: CourseObject["props"]; scope?: CourseObject["scope"] }) => {
    const prev = { geometry: o.geometry, props: o.props, scope: o.scope };
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k as keyof typeof prev]]));
    void (async () => {
      const redo = () => writes.updateObject({ id: o.id, ...patch });
      if ((await run(redo)) === undefined) return;
      record(() => writes.updateObject({ id: o.id, ...before }), redo);
    })();
  }, [writes, run, record]);

  const deleteObject = useCallback((o: CourseObject) => {
    const body = { kind: o.kind, geometry: o.geometry, props: o.props, scope: o.scope } as Pick<CourseObject, "kind" | "geometry" | "props" | "scope">;
    const box = { id: o.id };
    void (async () => {
      const redo = async () => { await writes.deleteObject(box.id); return true; };
      if ((await run(redo)) === undefined) return;
      record(async () => { box.id = (await writes.createObject(body)).id; }, redo);
      dispatch({ type: "select-object", id: null });
    })();
  }, [writes, run, record]);

  // ─── Snapping (§6.2) ──────────────────────────────────────
  const snapIndex = useMemo(
    () => (state.snapping && mapDoc ? snapIndexForDocument(mapDoc.hash, mapDoc.bytes) : null),
    [state.snapping, mapDoc],
  );
  const snap = useCallback((pt: Pt): Pt => snapIndex?.nearest(pt) ?? pt, [snapIndex]);

  // ─── Tools (§6) ──────────────────────────────────────────
  const gesture = useRef<Gesture>(null);
  const [, setRedraw] = useState(0);
  const redraw = useCallback(() => setRedraw((v) => v + 1), []);
  /** The armed chain, kept in a ref as well: queued placements read the newest. */
  const chainRef = useRef<PlacementState | null>(null);
  const placeQueue = useRef<Promise<unknown>>(Promise.resolve());
  /** The undo entries of placements (`Ctrl+Z` steps the chain back only for one of them). */
  const placementEntries = useRef(new WeakSet<object>());
  const [hover, setHover] = useState<{ pt: Pt; target: ToolPointer["target"] } | null>(null);
  const onHover = useCallback((p: ToolPointer | null) => {
    setHover((prev) => {
      if (!p) return prev === null ? prev : null;
      const pt = snap(p.pt);
      const same = prev && Math.abs(prev.pt.x - pt.x) < 1e-6 && Math.abs(prev.pt.y - pt.y) < 1e-6 && prev.target?.kind === p.target?.kind
        && (prev.target as { id?: unknown } | null)?.id === (p.target as { id?: unknown } | null)?.id;
      return same ? prev : { pt, target: p.target };
    });
  }, [snap]);

  const armContext = useCallback(() => ({
    rows, course: !!(selectedCourse && structure), selectedControlId: state.selectedControlId, legInsertAt: state.phantom?.insertAt ?? null,
  }), [rows, selectedCourse, structure, state.selectedControlId, state.phantom]);

  const setTool = useCallback((tool: EditorTool) => {
    gesture.current = null;
    chainRef.current = tool.kind === "place" ? tool.chain : null;
    setHover(null);
    dispatch({ type: "tool", tool });
  }, []);

  const armPlace = useCallback((tool: PlacementTool) => {
    const current = chainRef.current;
    const chain = current ? switchTool(current, tool, armContext()) : armPlacement(tool, armContext());
    setTool({ kind: "place", chain });
  }, [armContext, setTool]);

  const exitTool = useCallback(() => setTool({ kind: "select" }), [setTool]);

  const setChain = useCallback((chain: PlacementState) => {
    chainRef.current = chain;
    dispatch({ type: "chain", chain });
  }, []);

  /** One click of an armed tool (08 §5.3): a new site, or an existing one reused; one write chain, one undo entry. */
  const place = useCallback((p: ToolPointer) => {
    const pt = snap(p.pt);
    const targetId = p.target?.kind === "site" ? Number(p.target.id) : null;
    placeQueue.current = placeQueue.current.then(async () => {
      const chain = chainRef.current;
      if (!chain) return;
      const kindOfL = latest.current.kindOf;
      const targetKind = targetId !== null ? kindOfL(targetId) : null;
      let id: number | null;
      if (chain.tool === "control") {
        if (targetId !== null) {
          if (targetKind !== "control") return;
          // Reuse the site: into the course at the insertion point, no new site.
          if (chain.insertAt === null) { dispatch({ type: "select", id: targetId }); return; }
          const at = chain.insertAt;
          if (!(await applyStructure((s) => insertSite(s, at, targetId, kindOfL)))) return;
          id = targetId;
        } else {
          const at = chain.insertAt;
          id = await createSite(pt, "control", at !== null ? (s, newId) => insertSite(s, at, newId, kindOfL) : null);
        }
      } else {
        const role = chain.tool;
        const edit = chain.insertAt !== null ? (s: Structure, siteId: number) => setRole(s, role, siteId, kindOfL) : null;
        if (targetId !== null) {
          if (targetKind !== role) return;
          if (edit && !(await applyStructure((s) => edit(s, targetId)))) return;
          id = targetId;
        } else {
          id = await createSite(pt, role, edit);
        }
      }
      if (id === null || chainRef.current !== chain) return;
      if (undoStack.top) placementEntries.current.add(undoStack.top);
      dispatch({ type: "placed", id });
      const next = afterPlaced(chain, id);
      if (chain.tool === "finish") exitTool(); // a finish ends the chain
      else setChain(next);
    }).catch(() => {});
  }, [snap, applyStructure, createSite, setChain, exitTool, undoStack]);

  /** `A` → a kind: the polygon flow, or the toner saver's hull from the course straight away. */
  const startArea = useCallback((kind: AreaChoice) => {
    if (kind !== "toner_saver") return setTool(areaTool(kind));
    const pts = rows.flatMap((r) => (r.pt ? [r.pt] : []));
    const hull = tonerSaverHull(pts, TONER_MARGIN_MM);
    if (!hull || !selectedCourse) return;
    void (async () => {
      const id = await createObject({ kind: "toner_saver", geometry: hull, props: { marginMm: TONER_MARGIN_MM }, scope: { courses: [selectedCourse.id], classes: [] } });
      setTool({ kind: "select" });
      if (id !== null) dispatch({ type: "select-object", id });
    })();
  }, [rows, selectedCourse, createObject, setTool]);

  const finishArea = useCallback((kind: AreaKind, vertices: Pt[]) => {
    setTool({ kind: "select" });
    void (async () => {
      const id = await createObject({ kind, geometry: vertices, props: defaultProps(kind), scope: { all: true } } as Pick<CourseObject, "kind" | "geometry" | "props" | "scope">);
      if (id !== null) dispatch({ type: "select-object", id });
    })();
  }, [createObject, setTool]);

  const placeText = useCallback((pt: Pt) => {
    setTool({ kind: "select" });
    void (async () => {
      const id = await createObject({ kind: "text", geometry: [pt], props: { text: t("newText"), fontSizeMm: TEXT_SIZE_MM }, scope: { all: true } });
      if (id !== null) dispatch({ type: "select-object", id });
    })();
  }, [createObject, setTool, t]);

  /** `G`'s target: the selected control's circle, or the clicked leg (§6.3). */
  const gapTarget = useMemo((): GapTarget | null => {
    const radiusMm = courseInfo?.metrics?.circleRadiusMm ?? 2.5;
    const sel = state.selectedControlId;
    if (sel !== null) {
      const c = coordsById.get(sel);
      if (!c || kindOf(sel) !== "control" || (c.mapX === 0 && c.mapY === 0)) return null;
      const stored = controlRowsById.get(sel)?.circleGaps ?? [];
      const effective = courseInfo?.derivation?.sites.find((d) => d.id === String(sel))?.cuts ?? [];
      return { kind: "circle", siteId: sel, centre: { x: c.mapX, y: c.mapY }, radiusMm, gaps: stored.length ? stored : effective, stored: stored.length > 0 };
    }
    const insertAt = state.tool.kind === "gap" ? state.tool.legInsertAt : state.phantom?.insertAt;
    if (insertAt == null || !structure) return null;
    const itemIndex = rows.findIndex((r) => (r.kind === "control" ? r.seqIndex === insertAt : r.kind === "finish" && insertAt >= sequenceIds.length));
    const to = rows[itemIndex], from = rows.slice(0, itemIndex).reverse().find((r) => r.pt);
    if (!to?.pt || !from?.pt) return null;
    const explicit = explicitStructure(structure, sites);
    const item = explicit.items[itemIndex];
    const stored = item && item.kind !== "variation" ? item.leg?.gaps ?? [] : [];
    const effective = courseInfo?.derivation?.courses[0]?.legs.find((l) => l.from === String(from.id) && l.to === String(to.id))?.gaps ?? [];
    return { kind: "leg", itemIndex, a: from.pt, b: to.pt, gaps: stored.length ? stored : effective, stored: stored.length > 0 };
  }, [courseInfo, state.selectedControlId, state.phantom, state.tool, coordsById, kindOf, controlRowsById, structure, rows, sequenceIds, sites]);

  const writeGaps = useCallback((target: GapTarget, gaps: AngularGap[] | FractionGap[]) => {
    if (target.kind === "circle") {
      const id = target.siteId;
      const prev = controlRowsById.get(id)?.circleGaps ?? [];
      void (async () => {
        const redo = () => writes.updateControl({ id, circleGaps: gaps } as Parameters<typeof writes.updateControl>[0]);
        if ((await run(redo)) === undefined) return;
        record(() => writes.updateControl({ id, circleGaps: prev } as Parameters<typeof writes.updateControl>[0]), redo);
      })();
    } else {
      void applyStructure((s) => setLegGaps(s, target.itemIndex, gaps as FractionGap[]));
    }
  }, [controlRowsById, writes, run, record, applyStructure]);

  // The ghost's description: the top autodetect candidate under the cursor (08 §5.3), asked once the pointer rests.
  const [ghostAsk, setGhostAsk] = useState<Pt | null>(null);
  const placing = state.tool.kind === "place" ? state.tool.chain : null;
  useEffect(() => {
    if (!placing || placing.tool !== "control" || !hover || hover.target) { setGhostAsk(null); return; }
    const h = setTimeout(() => setGhostAsk({ x: Math.round(hover.pt.x * 10) / 10, y: Math.round(hover.pt.y * 10) / 10 }), 150);
    return () => clearTimeout(h);
  }, [placing, hover]);
  const ghostSuggest = trpc.control.suggestDescription.useQuery(
    { x: ghostAsk?.x ?? 0, y: ghostAsk?.y ?? 0 },
    { enabled: !!ghostAsk && !!mapInfo.data, staleTime: Number.POSITIVE_INFINITY },
  );
  const ghostDescription = useMemo(() => {
    const top = ghostAsk ? ghostSuggest.data?.candidates?.[0] : undefined;
    if (!top) return null;
    const parts = (["c", "d", "e", "g"] as const).flatMap((col) => {
      const v = top[col];
      const iof = v ? ocadToIof(col, v) : null;
      return iof ? [iofSymbolName(iof, i18n.language)] : [];
    });
    return parts.length ? parts.join(" · ") : null;
  }, [ghostAsk, ghostSuggest.data, i18n.language]);

  const nextCode = useMemo(() => {
    if (!controlList.data) return null;
    const used = [...controlList.data.map((c) => c.codes), ...[...created.current.values()].flatMap((c) => (c.code !== null ? [String(c.code)] : []))];
    return nextSeriesControlCode(seriesAllocation.data ?? [], used, activeSeriesId).code;
  }, [controlList.data, seriesAllocation.data, activeSeriesId, pendingOps]); // eslint-disable-line react-hooks/exhaustive-deps

  const ptOf = useCallback((id: number): Pt | null => {
    const c = coordsById.get(id);
    if (c && (c.mapX !== 0 || c.mapY !== 0)) return { x: c.mapX, y: c.mapY };
    return created.current.get(id)?.pt ?? null;
  }, [coordsById]);

  const ghost = useMemo(() => {
    if (!placing || !hover) return null;
    const reuseId = hover.target?.kind === "site" ? Number(hover.target.id) : null;
    const reuse = reuseId !== null && kindOfLatest(reuseId) === (placing.tool === "control" ? "control" : placing.tool) ? reuseId : null;
    const at = reuse !== null ? ptOf(reuse) ?? hover.pt : hover.pt;
    const info = ghostInfo(placing, rows, at, ptOf);
    const radiusMm = placing.tool === "finish" ? courseInfo?.metrics?.finishRadiusMm ?? 3 : placing.tool === "start" ? courseInfo?.metrics?.startRadiusMm ?? 3.5 : courseInfo?.metrics?.circleRadiusMm ?? 2.5;
    const code = reuse !== null ? coordsById.get(reuse)?.code ?? String(reuse) : null;
    const label = reuse !== null
      ? t("ghostReuse", { code })
      : placing.tool === "control"
        ? [info.number !== null ? String(info.number) : null, nextCode !== null ? String(nextCode) : null].filter(Boolean).join(" · ")
        : t(placing.tool === "start" ? "kindStart" : "kindFinish");
    return { at, radiusMm, role: placing.tool, label, description: reuse === null ? ghostDescription : null, legs: info.legs, legMm: info.legMm };
  }, [placing, hover, kindOfLatest, ptOf, rows, courseInfo, coordsById, t, nextCode, ghostDescription]);

  const sitesForTools = useMemo(() => sites.filter((x) => x.mapX !== 0 || x.mapY !== 0)
    .map((x) => ({ id: x.id, x: x.mapX, y: x.mapY, kind: kindOf(x.id) })), [sites, kindOf]);

  const insertOnLeg = useCallback((target: { courseId: string; index: number }, pt: Pt) => {
    if (!selectedCourse || target.courseId !== selectedCourse.name) return;
    void createControl(snap(pt), insertIndexForLeg(rows, target.index));
  }, [selectedCourse, rows, createControl, snap]);

  const tool = state.tool;
  const toolBinding: EditorToolBinding | null = (() => {
    switch (tool.kind) {
      case "place":
        return placeBinding({ ghost, onHover, onPlace: place, onExit: exitTool, touch: { placeLabel: t("touchPlace"), doneLabel: t("touchDone") } });
      case "area":
        return areaBinding({
          gesture, poly: tool.poly, hover: hover?.pt ?? null, onHover, snap,
          onPoly: (poly) => dispatch({ type: "polygon", poly }),
          onDone: (vertices) => finishArea(tool.poly.kind, vertices),
          onCancel: exitTool,
        });
      case "text":
        return textBinding({ onPlace: placeText, onExit: exitTool, snap });
      case "gap":
        return gapTarget ? gapBinding({
          gesture, target: gapTarget, redraw,
          onAdd: (gap) => writeGaps(gapTarget, gapTarget.kind === "circle" ? mergeCircleGaps([...gapTarget.gaps, gap as AngularGap]) : mergeLegGaps([...gapTarget.gaps, gap as FractionGap])),
          onRemove: (i) => writeGaps(gapTarget, (gapTarget.gaps as (AngularGap | FractionGap)[]).filter((_, k) => k !== i) as AngularGap[] | FractionGap[]),
          onExit: exitTool,
        }) : null;
      case "select":
        return selectBinding({
          gesture, redraw, selected: selectedObject, objects: objectsInView.map((o) => (drafts.has(o.id) ? { ...o, geometry: drafts.get(o.id)! } : o)),
          sites: sitesForTools, multi: state.multi, ringMm: courseInfo?.metrics?.circleRadiusMm ?? 2.5,
          onToggleMulti: (id) => dispatch({ type: "toggle-multi", id }),
          onLasso: (ids) => dispatch({ type: "set-multi", ids }),
          onSelectObject: (id) => dispatch({ type: "select-object", id }),
          onObjectDraft: setDraft,
          onObjectMoved: (id, geometry) => {
            const o = objects.find((x) => x.id === id);
            setDraft(id, geometry);
            if (o) updateObject(o, { geometry });
          },
          onLegDoubleClick: insertOnLeg,
        });
    }
  })();

  // Drafts: objects being dragged (a region's drag is live, 08 §5.3). A region being drawn picks nothing yet (§6.4).
  const draftObjects = useMemo(() => {
    if (drafts.size === 0) return NO_DRAFTS;
    const out: CourseObject[] = [];
    for (const [id, geometry] of drafts) {
      const o = objects.find((x) => x.id === id);
      if (o) out.push({ ...o, geometry } as CourseObject);
    }
    return out;
  }, [drafts, objects]);
  const draftFast = [...drafts.keys()].some((id) => objects.find((o) => o.id === id)?.kind === "filter_region");

  const [viewRequest, setViewRequest] = useState<MapViewerEditorProps["viewRequest"]>(null);

  // ─── The action bar ──────────────────────────────────────
  const ends = useMemo(() => (structure ? effectiveEnds(structure, sites) : { start: null, finish: null }), [structure, sites]);
  const contextActions = useMemo(() => {
    // An armed tool opens no action bar (08 §5.3: it would cover the map on every placement).
    if (state.tool.kind !== "select") return [];
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
  }, [state.tool.kind, state.selectedControlId, state.phantom, coordsById, kindOf, sequenceIds, ends, selectedCourse, structure, controlRowsById,
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
  const toolActive = state.tool.kind !== "select";
  const editor: MapViewerEditorProps = useMemo(() => ({
    selectedControlId: state.selectedControlId !== null ? String(state.selectedControlId) : null,
    phantom: state.phantom ? { x: state.phantom.x, y: state.phantom.y } : null,
    contextActions,
    // An active tool opens no action bar (§6): nothing in it, not even the info line and badges.
    contextInfo: toolActive ? null : contextInfo,
    contextBadge: toolActive ? null : srrBadge,
    contextRadioBadge: radioOn && !toolActive ? { label: tc("editor.radioBadge") } : null,
    suggestions: toolActive ? [] : suggestions,
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
    tool: toolBinding,
    snap: snapIndex ? snap : null,
    draftObjects,
    draftFast,
    viewRequest,
    onCourseInfo: setCourseInfo,
  }), [state.selectedControlId, state.phantom, contextActions, contextInfo, srrBadge, radioOn, suggestions, tc, courseControlIds, toolActive,
    courseView, selectedCourse, moveWarnings, moveEpoch, handleMapClick, handleMoveEnd, handleLabelMoveEnd, handleSelect,
    handleDismiss, handleLegClick, toolBinding, snapIndex, snap, draftObjects, draftFast, viewRequest]);

  // ─── Undo / redo, keyboard, deep links ───────────────────
  const runUndo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => { await undoStack.undo(); bumpHistory(); });
  }, [run, undoStack, bumpHistory]);
  const runRedo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => { await undoStack.redo(); bumpHistory(); });
  }, [run, undoStack, bumpHistory]);

  /** Tab / Shift+Tab: the next / previous control of the course, centred (§6.5). */
  const stepSelection = useCallback((dir: 1 | -1) => {
    const controls = rows.filter((r) => r.kind === "control");
    if (controls.length === 0) return;
    const at = controls.findIndex((r) => r.id === state.selectedControlId);
    const next = controls[at < 0 ? (dir > 0 ? 0 : controls.length - 1) : (at + dir + controls.length) % controls.length];
    dispatch({ type: "select", id: next.id });
    if (next.pt) setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, centre: next.pt! }));
  }, [rows, state.selectedControlId]);

  /** F: fit the selected course, else every positioned control. */
  const fitView = useCallback(() => {
    const ids = rows.length > 0 ? rows.filter((r) => r.pt).map((r) => String(r.id)) : sitesForTools.map((x) => String(x.id));
    setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, fit: ids }));
  }, [rows, sitesForTools]);

  const [areaOpen, setAreaOpen] = useState(false);
  const canGap = state.selectedControlId !== null ? kindOf(state.selectedControlId) === "control" : (state.phantom?.insertAt ?? null) !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (descControlId !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const plain = !mod && !e.altKey;
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) runRedo();
        else {
          // Ctrl+Z while armed: the anchor goes back with the last placement (08 §5.3) — only when the entry
          // about to be undone is that placement: an inspector edit made meanwhile leaves the chain alone.
          const chain = chainRef.current;
          const top = undoStack.top;
          const stepsChain = state.tool.kind === "place" && !!chain && chain.placed.length > 0 && !!top && placementEntries.current.has(top);
          runUndo();
          if (stepsChain && chain) setChain(afterUndo(chain));
        }
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        runRedo();
      } else if (e.key === "Escape") {
        setAreaOpen(false);
        // The cascade first; with nothing left, Esc leaves fullscreen (MapPanel holds the Keyboard Lock).
        if (!escapeHasWork(state) && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else {
          setRadioSwapOffer(null);
          if (state.tool.kind !== "select") exitTool();
          else dispatch({ type: "escape" });
        }
      } else if (e.key === "Enter" && plain) {
        if (state.tool.kind === "area") {
          e.preventDefault();
          if (state.tool.poly.vertices.length >= (state.tool.poly.kind === "oob_line" || state.tool.poly.kind === "marked_route" ? 2 : 3)) {
            finishArea(state.tool.poly.kind, state.tool.poly.vertices);
          }
        } else if (state.tool.kind !== "select") {
          e.preventDefault();
          exitTool();
        }
      } else if (e.key === "Tab" && !mod) {
        e.preventDefault();
        stepSelection(e.shiftKey ? -1 : 1);
      } else if (plain && key === "H") {
        dispatch({ type: "toggle-hide-others" });
      } else if (plain && key === "V") {
        exitTool();
      } else if (plain && (key === "S" || key === "K" || key === "M")) {
        armPlace(key === "S" ? "start" : key === "M" ? "finish" : "control");
      } else if (plain && key === "A") {
        setAreaOpen((v) => !v);
      } else if (plain && key === "T") {
        setTool({ kind: "text" });
      } else if (plain && key === "G") {
        if (canGap) setTool({ kind: "gap", legInsertAt: state.selectedControlId === null ? state.phantom?.insertAt ?? null : null });
      } else if (plain && key === "F") {
        fitView();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (state.multi.length > 0) deleteControls(state.multi);
        else if (selectedObject) deleteObject(selectedObject);
        else handleDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [descControlId, runUndo, runRedo, undoStack, state, handleDelete, deleteControls, deleteObject, selectedObject, setChain, exitTool, finishArea,
    stepSelection, armPlace, setTool, canGap, fitView]);

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
    notes: controlRowsById.get(selectedCoord.id)?.notes ?? "",
    numberHidden: structure && sequenceIds.includes(selectedCoord.id)
      ? structure.items.some((i) => i.kind !== "variation" && i.siteId === selectedCoord.id && !!i.numberHidden)
      : null,
  } : null;

  const bulkAddToCourse = useCallback(() => {
    const ids = state.multi;
    void applyStructure((s) => ids.reduce((acc, id) => (kindOf(id) === "control" ? appendSite(acc, id, kindOf) : acc), s));
  }, [state.multi, applyStructure, kindOf]);
  const bulkRadio = useCallback(() => {
    const ids = state.multi.filter((id) => kindOf(id) === "control");
    if (ids.length) void run(() => client.control.upsertConfig.mutate({ controlIds: ids, radioType: "internal_radio" }));
  }, [state.multi, kindOf, run, client]);

  const pendingLegM = ghost?.legMm != null && mapScale ? (ghost.legMm * mapScale) / 1000 : null;

  const overlay = (
    <div className="flex gap-2 h-full min-h-0 items-stretch">
      {/* The course objects as DOM, for tests: what the editor holds (§7). */}
      <ul data-testid="editor-objects" hidden>
        {objects.map((o) => (
          <li key={o.id} data-testid="editor-object-row" data-object-id={o.id} data-object-kind={o.kind}
            data-geometry={o.geometry.map((v) => `${v.x},${v.y}`).join(" ")} data-props={JSON.stringify(o.props)} data-scope={JSON.stringify(o.scope)} />
        ))}
      </ul>
      <ToolRail
        tool={state.tool}
        onTool={(key) => {
          if (key === "V") exitTool();
          else if (key === "S" || key === "K" || key === "M") armPlace(key === "S" ? "start" : key === "M" ? "finish" : "control");
          else if (key === "T") setTool({ kind: "text" });
          else if (key === "G") setTool({ kind: "gap", legInsertAt: state.selectedControlId === null ? state.phantom?.insertAt ?? null : null });
        }}
        onArea={startArea}
        areaOpen={areaOpen}
        onAreaOpen={setAreaOpen}
        canGap={canGap}
        canTonerSaver={!!selectedCourse && rows.some((r) => r.pt)}
        snapping={state.snapping}
        onSnapping={() => dispatch({ type: "toggle-snapping" })}
      />
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
            {state.multi.length > 1 ? (
              <MultiSection count={state.multi.length} course={selectedCourse && structure ? selectedCourse.name : null} busy={pendingOps > 0}
                onDelete={() => deleteControls(state.multi)} onAddToCourse={bulkAddToCourse} onRadio={bulkRadio} />
            ) : selectedObject ? (
              <ObjectSection
                object={drafts.has(selectedObject.id) ? { ...selectedObject, geometry: drafts.get(selectedObject.id)! } as CourseObject : selectedObject}
                document={mapDoc?.header ?? null}
                courses={courseOptions}
                classes={(classes.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
                onProps={(props) => updateObject(selectedObject, { props })}
                onScope={(scope) => updateObject(selectedObject, { scope })}
                onRegenerate={selectedObject.kind === "toner_saver" ? () => {
                  const margin = (selectedObject.props as { marginMm?: number }).marginMm ?? TONER_MARGIN_MM;
                  const hull = tonerSaverHull(rows.flatMap((r) => (r.pt ? [r.pt] : [])), margin);
                  if (hull) updateObject(selectedObject, { geometry: hull });
                } : undefined}
                onDelete={() => deleteObject(selectedObject)}
              />
            ) : (
              <SelectionSection
                selected={selectedInfo}
                onKind={(kind) => { if (selectedCoord) updateField(selectedCoord.id, { kind }, { kind: kindOf(selectedCoord.id) }); }}
                onNotes={(notes) => { if (selectedCoord) updateField(selectedCoord.id, { notes }, { notes: controlRowsById.get(selectedCoord.id)?.notes ?? "" }); }}
                onNumberHidden={(hidden) => { if (selectedCoord) { const id = selectedCoord.id; void applyStructure((s) => setNumberHidden(s, id, hidden)); } }}
              />
            )}
          </InspectorSection>
          <InventorySection inventory={inventory} activeSeriesId={activeSeriesId} onSeries={setAllocSeriesId} />
          <ChecksSection />
        </Inspector>
        <div className="mt-auto flex flex-col gap-1">
          {state.tool.kind === "gap" && gapTarget?.stored && (
            // Stored gaps replace the automatic ones (§6.3): an empty list is automatic again.
            <button type="button" data-testid="editor-gap-reset" onClick={() => writeGaps(gapTarget, [])}
              className="pointer-events-auto w-fit px-2 py-1 rounded-md bg-white/95 border border-purple-200 text-purple-700 text-[11px] shadow-sm hover:bg-purple-50 cursor-pointer">
              {t("resetGaps")}
            </button>
          )}
          {showExhausted && <span data-testid="series-exhausted" className="pointer-events-auto w-fit text-[11px] text-amber-700 bg-white/95 rounded px-1.5">{tc("seriesExhausted")}</span>}
          {errorMsg && <span data-testid="editor-error" className="pointer-events-auto w-64 text-[11px] text-red-600 bg-white/95 rounded px-1.5">{errorMsg}</span>}
          <StatusBar controls={selectedCourse ? sequenceIds.length : null} lengthM={selectedCourse ? totalMeters : null} scale={mapScale} save={save}
            pendingLegM={pendingLegM} snapping={state.snapping} />
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

/**
 * The course editor (docs/course-editor.md), mounted on
 * `/:nameId/course-editor` for every event (`CourseEditorRoute`). One GL canvas (`MapPanel` → `MapViewer` over
 * `VectorMapLayer`) with the shell around it: top bar, tool rail,
 * contextual action bar, inspector; the save indicator and the course-info popover in the top bar (§2; P2).
 *
 * - Selection is the legacy model (`lib/editor/state.ts`); the viewer
 *   hit-tests the course layer's symbolised shapes (§5).
 * - Every gesture is one write and one undo entry (`UndoStack`, 50).
 * - Sequence edits are `course.setStructure` with the course's token; the
 *   first save makes start and finish explicit (course-layer.md §6.2).
 *   Control writes are `control.update` with the control's token.
 *   `EditorWrites` applies the G1 client rules (§3); a conflict the user
 *   must see becomes the notice above the inspector.
 * - Autosave: there is no save button; the top bar's save indicator says saved /
 *   saving / not saved / changed elsewhere (the phone: the sheet's peek line).
 *
 * Course mode, Layout mode (`modes/LayoutMode.tsx`, docs/course-layout.md:
 * the sheet as the view, course edits locked) and Field mode (§9; the phone default, with the bottom
 * sheet and the compact chrome of §10). The tools (§6: the armed
 * `S` / `K` / `M`, `A` areas, `T` text, `G` gaps, snapping, Shift-click /
 * lasso multi-select) and course objects (§7) are D5's: each tool is a
 * viewer binding (`tools/bindings.ts`) built here from the state.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { course as courseShared, type ControlDescription, type ControlKind, type course } from "@oxygen/shared";
import { trpc } from "../../lib/trpc";
import { MapPanel } from "../../components/MapPanel";
import { ControlDescriptionEditor } from "../../components/ControlDescriptionEditor";
import type { EditorDescriptionSuggestion, EditorToolBinding, MapViewerEditorProps, ToolPointer } from "../../components/MapViewer";
import { useCoursePresence } from "../../hooks/useCoursePresence";
import { clockTime, courseChangedElsewhere } from "../../lib/editor/presence";
import { PresenceChips } from "./PresenceChips";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { PLACEMENT_LOUPE_KEY } from "../../lib/editor/touch";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { useCapabilities } from "../../context/CapabilitiesContext";
import { paperFrameOf } from "../../lib/vector-map";
import { bandCentreOffsetPx, fieldRows, fixToPaper, initialModeFor, type Detent } from "../../lib/editor/field";
import { BottomSheet } from "../../components/editor/BottomSheet";
import { IOF_SYMBOLS } from "../../iof-symbols";
import { iofSymbolName } from "../../iof-symbol-meta";
import { ocadToIof } from "../../lib/control-description-options";
import {
  buildInventoryView, codesHaveSrr, courseMembership, courselessClassNames, matchCourselessClass,
  nextFreeSrrCode, nextSeriesControlCode, sequenceLegMeters,
} from "../../lib/course-editor";
import { UndoStack } from "../../lib/undo-stack";
import { useMapDocument } from "../../lib/map-document-cache";
import { courseObjectsForView, provisionalDrawn, type ProvisionalVisit } from "../../lib/course-layer-request";
import { snapIndexForDocument } from "../../lib/editor/snap";
import { pickIndexForDocument } from "../../lib/editor/symbol-pick";
import { groupOfSymbol, swatchUrl, symbolGroups, type SymbolGroup } from "../../lib/editor/symbol-groups";
import { deleteVertex, vertexRule, type Vertex } from "../../lib/editor/geometry-edit";
import { legLengthLabel } from "../../lib/editor/leg-length";
import { EditorConflict, EditorWrites, type EditorClient } from "../../lib/editor/write-client";
import { instructionsOnCourse, type Instructions } from "../../lib/editor/instructions";
import { areaTool, editorReducer, escapeHasWork, initialEditorState, type EditorTool } from "../../lib/editor/state";
import {
  addAlternative, appendSite, canCreateGroup, createGroup, displayPath, insertSite, itemAtPath, moveToAlternative, moveVisit, removeAlternative, removeSite, removeVisit,
  renameAlternative, setLegGaps, setLegProps, setLoop, setNumberHidden, setRole, DEFAULT_CORRIDOR, type GroupOrders, type KindOf, type LegPatch,
} from "../../lib/editor/structure-edit";
import { allVariationDraws, courseDrawOf, shownLegDraftOf, type HeldLegDraft } from "../../lib/editor/variation-view";
import { alternativeEndAt, courseViewOrders, displaySequence, effectiveEnds, explicitStructure, insertIndexForLeg, kindOfSites, legForInsert, legMeterInputs, variationBlocks, type SiteRow } from "../../lib/editor/sequence";
import { insertBendAt, legPolyline, projectOnPolyline, setBendKind, type Bend } from "../../lib/editor/bends";
import { courseActions } from "./ActionBar";
import { TopBar } from "./TopBar";
import { ToolRail, type AreaChoice } from "./ToolRail";
import { areaChoiceOfKey, isCorridorKey } from "./tools/rail";
import { afterPlaced, afterUndo, armPlacement, endsChain, ghostInfo, isVisitTool, switchTool, type PlacementState, type PlacementTool } from "./tools/placement";
import { step as polygonStep, type AreaKind } from "./tools/polygon";
import { TONER_MARGIN_MM, tonerSaverGeometry } from "./tools/toner-saver";
import { mergeCircleGaps, mergeLegGaps, type AngularGap, type FractionGap } from "./tools/gaps";
import { areaBinding, gapBinding, pickSymbolBinding, placeBinding, selectBinding, textBinding, withCorridorGuides, type CorridorGuide, type GapTarget, type Gesture } from "./tools/bindings";
import { ObjectSection } from "./modes/ObjectSection";
import { LegSection } from "./modes/LegSection";
import { ChecksSection, Inspector, InspectorSection, InventorySection } from "./Inspector";
import { StatusBar } from "./StatusBar";
import type { SaveState, StatusInput } from "../../lib/editor/status";
import type { MapInfoInput } from "../../lib/editor/map-info";
import { useCourseChecks } from "./useCourseChecks";
import type { EditorCheck } from "../../lib/editor/checks";
import { CourseSection, MultiSection, SelectionSection } from "./modes/CourseMode";
import { AddMenu, FieldSection, FieldSelection, FieldTopBar, FixStatus, OfflineNotice, OverflowMenu, type AddChoice } from "./modes/FieldMode";
import { useFieldFix } from "./useFieldFix";
import { useLayoutMode } from "./modes/LayoutMode";
import { editorSearchFor, parseEditorUrl, type EditorUrlState } from "../../lib/editor/url";
import { useClassView } from "./modes/ClassView";

type Pt = { x: number; y: number };
type Structure = course.WireCourseStructure;
type CourseObject = course.CourseObject;

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
  | { kind: "moved"; controlId: number; mine: Pt; theirs: Pt | null; by?: { name: string; at: string } | null };

export function EditorPage() {
  const { t } = useTranslation("editor");
  const { t: tc, i18n } = useTranslation("courses");
  const isMobile = useMediaQuery("(max-width: 639px)");
  const utils = trpc.useUtils();
  const [searchParams, setSearchParams] = useSearchParams();
  const { nameId } = useParams<{ nameId: string }>();
  // The URL as the editor opened (§1 "URL"; F31), read once.
  const [inbound] = useState(() => parseEditorUrl(searchParams));
  // A phone opens in Field mode (§9, §10); the URL's `mode` wins, but Layout is not a phone mode.
  const [state, dispatch] = useReducer(editorReducer, isMobile, (phone: boolean) => ({ ...initialEditorState, mode: initialModeFor({ phone, url: inbound.mode }) }));
  const fieldMode = state.mode === "field";
  const online = useOnlineStatus();
  const caps = useCapabilities();
  const canReview = caps.has("courses.review");
  const canEdit = caps.has("courses.edit");
  const geo = useFieldFix(fieldMode);

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
    () => (controlCoords.data ?? []).map((c) => ({ id: c.id, code: c.code, status: c.status, mapX: c.mapX, mapY: c.mapY, kind: c.kind })),
    [controlCoords.data],
  );
  const kindOf = useMemo(() => kindOfSites(sites), [sites]);
  /** A site's kind (course-layer.md §6.3): crossing and map-issue points are never items, `kindOf` reads them as controls. */
  const siteKindOf = useMemo(() => {
    const byId = new Map((controlCoords.data ?? []).map((c) => [c.id, c.kind as ControlKind] as const));
    return (id: number): ControlKind => byId.get(id) ?? "control";
  }, [controlCoords.data]);
  // A site this client just created counts before the coordinates refetch (`created`, below).
  const isMark = useCallback((id: number) => { if (created.current.get(id)?.mark) return true; const k = siteKindOf(id); return k === "crossing_point" || k === "map_issue"; }, [siteKindOf]);
  /** A crossing point's position, for the legs through it (§6.8). */
  const crossingPt = useCallback((leg: { crossing?: { controlId: number } } | undefined) => {
    const c = leg?.crossing ? (controlCoords.data ?? []).find((x) => x.id === leg.crossing!.controlId) : undefined;
    return c && (c.mapX !== 0 || c.mapY !== 0) && c.kind === "crossing_point" ? { x: c.mapX, y: c.mapY } : null;
  }, [controlCoords.data]);
  const coordsById = useMemo(() => new Map((controlCoords.data ?? []).map((c) => [c.id, c] as const)), [controlCoords.data]);
  const controlRowsById = useMemo(() => new Map((controlList.data ?? []).map((c) => [c.id, c] as const)), [controlList.data]);
  const selectedCourse = useMemo(
    () => (state.selectedCourseId !== null ? courses.data?.find((c) => c.id === state.selectedCourseId) ?? null : null),
    [state.selectedCourseId, courses.data],
  );

  // Presence (D11): who else has a course open. Heartbeat on the poll's cadence while a course is open.
  const presence = useCoursePresence(state.selectedCourseId, state.mode);
  // A course token this client did not write moved: re-render has happened by the poll's invalidation; say so (never silent).
  const [external, setExternal] = useState<{ who: string | null; at: string | null } | null>(null);
  const seenCourse = useRef<{ id: number; version: string } | null>(null);
  const courseVersion = selectedCourse?.version;
  const courseSeq = selectedCourse?.id ?? null;
  useEffect(() => {
    const prev = seenCourse.current;
    seenCourse.current = courseSeq !== null && courseVersion !== undefined ? { id: courseSeq, version: courseVersion } : null;
    if (!prev || courseSeq !== prev.id) { setExternal(null); return; }
    if (!courseChangedElsewhere(prev.version, courseVersion, writes.ownCourseVersions)) return;
    setExternal({ who: null, at: null });
    void client.course.lastChange.query({ courseId: courseSeq }).then(
      (by) => setExternal((x) => (x ? { who: by?.name || null, at: by?.at ?? null } : x)),
      () => undefined,
    );
  }, [courseSeq, courseVersion, writes, client]);
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
  /** The structure as drawn, start and finish explicit: each row's `path` names its item here (the leg into it is its `leg`). */
  const explicit = useMemo(() => (structure ? explicitStructure(structure, sites) : null), [structure, sites]);
  // ─── Variations (§12): the displayed alternatives, the variants, the view's orders ──
  const variants = useMemo(() => (structure ? courseShared.variantOrders(structure) : []), [structure]);
  const hasGroups = variants.length > 0;
  const variantKeys = useMemo(() => variants.map((v) => v.key), [variants]);
  // An edit that drops the shown variant's key (Loop, a removed alternative, undo) returns to Course view (§12).
  useEffect(() => {
    if (state.view === "variant" && structure && !variantKeys.includes(state.variantKey ?? "")) dispatch({ type: "variant", key: null });
  }, [state.view, state.variantKey, structure, variantKeys]);
  /** How the view shows each group: Variant view the variant's order, else the active alternatives (default the first). */
  const orders: GroupOrders | undefined = useMemo(() => {
    if (!structure || !hasGroups) return undefined;
    const variant = state.view === "variant" ? variants.find((v) => v.key === state.variantKey) : undefined;
    return variant ? variant.orders : courseViewOrders(structure, state.activeAlternatives);
  }, [structure, hasGroups, state.view, state.variantKey, state.activeAlternatives, variants]);
  /**
   * The variant Class view and Layout mode draw a root as (F8; course-editor.md §12, course-print.md §4.6):
   * the remembered key while the structure has it, else the first — a root prints only as its variants.
   */
  const sheetVariant = hasGroups && (state.mode === "layout" || state.view === "class")
    ? (state.variantKey && variantKeys.includes(state.variantKey) ? state.variantKey : variantKeys[0])
    : null;
  const rows = useMemo(() => (structure ? displaySequence(structure, sites, orders) : []), [structure, sites, orders]);
  const blocks = useMemo(() => (structure && hasGroups ? variationBlocks(structure, sites, rows, orders) : []), [structure, hasGroups, sites, rows, orders]);
  const sequenceIds = useMemo(() => rows.filter((r) => r.kind === "control").map((r) => r.id), [rows]);
  /** Every site the course visits, in any alternative (§12: on the course, not faded). */
  const memberIds = useMemo(() => {
    const out = new Set(sequenceIds);
    for (const item of structure?.items ?? []) if (item.kind === "variation") for (const a of item.alternatives) for (const c of a.items) out.add(c.siteId);
    return out;
  }, [structure, sequenceIds]);
  /** The item a row names (undefined for a loop's anchor visit, §12). */
  const itemOfRow = useCallback((i: number) => (explicit && rows[i] ? itemAtPath(explicit, rows[i].path) : undefined), [explicit, rows]);
  const inventory = useMemo(
    () => buildInventoryView(seriesAllocation.data ?? [], (controlList.data ?? []).map((c) => c.codes)),
    [seriesAllocation.data, controlList.data],
  );
  const activeSeriesId = allocSeriesId !== null && inventory.some((s) => s.seriesId === allocSeriesId) ? allocSeriesId : null;
  // A materialised variant's controls are its root's (course-layer.md §12): it counts as the root, once.
  const membership = useMemo(() => {
    const list = courses.data ?? [];
    const nameOf = new Map(list.map((c) => [c.id, c.name] as const));
    const m = courseMembership(list.map((c) => (c.parentCourseId != null ? { ...c, name: nameOf.get(c.parentCourseId) ?? c.name } : c)));
    for (const [id, names] of m) m.set(id, [...new Set(names)]);
    return m;
  }, [courses.data]);
  /** The crossing points some course's leg runs through (§6.6: their kind stays). */
  const crossingRefs = useMemo(() => new Set((courses.data ?? []).flatMap((c) => Object.values(c.legs ?? {}).flatMap((l) => (l.crossing ? [Number(l.crossing.controlId)] : [])))), [courses.data]);

  // ─── Field mode (§9): the fix on paper, distance / bearing, check-off ─
  const rotationCorrection = mapMetadata.data?.rotationCorrection;
  const paperFrame = useMemo(() => (mapDoc ? paperFrameOf(mapDoc.header, rotationCorrection) : null), [mapDoc, rotationCorrection]);
  const fix = fieldMode ? geo.position : null;
  const paperFix = useMemo(() => (fix ? fixToPaper(paperFrame, fix) : null), [fix, paperFrame]);
  const checkedIds = useMemo(() => new Set((controlList.data ?? []).filter((c) => c.checkedAt).map((c) => c.id)), [controlList.data]);
  const fieldList = useMemo(() => fieldRows(rows, paperFix, mapScale, checkedIds), [rows, paperFix, mapScale, checkedIds]);

  // ─── Write plumbing ──────────────────────────────────────
  const invalidate = useCallback(() => {
    void utils.course.controlCoordinates.invalidate();
    void utils.control.list.invalidate();
    void utils.course.list.invalidate();
    void utils.course.detail.invalidate();
    // Course objects are cached until reload in MapPanel: every write invalidates them (course-layer.md §8.3).
    void utils.courseObject.list.invalidate();
    void utils.course.checks.invalidate();
    // A structure write re-materialises the variants and deals their runners (F6b): Export ▾'s counts (F8).
    void utils.course.variantList.invalidate();
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
        if (e.decision.kind === "moved" && move) {
          const { controlId, mine } = move;
          setNotice({ kind: "moved", controlId, mine, theirs: e.decision.theirs });
          // "Moved by X at T" (D11): the actor and clock of the control's last write.
          void client.control.lastChange.query({ id: controlId }).then(
            (by) => setNotice((n) => (n?.kind === "moved" && n.controlId === controlId ? { ...n, by } : n)),
            () => undefined,
          );
        }
        else setNotice({ kind: "refresh", items: e.decision.kind === "refresh" ? e.decision.differing : null });
      } else {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
      return undefined;
    } finally {
      setPendingOps((n) => n - 1);
      invalidate();
    }
  }, [invalidate, client]);

  /** Push an undo entry for a write that succeeded. */
  const record = useCallback((undo: () => Promise<unknown>, redo: () => Promise<unknown>) => {
    const entry = { undo, redo };
    undoStack.push(entry);
    bumpHistory();
    return entry;
  }, [undoStack, bumpHistory]);

  const layoutMode = useLayoutMode({
    enabled: state.mode === "layout",
    nameId: nameId ?? "",
    course: selectedCourse ? { id: selectedCourse.id, name: selectedCourse.name } : null,
    view: state.view,
    classSeq: state.classSeq,
    variantKey: sheetVariant,
    run,
    record,
  });
  // A root's variants as stored, with their runners (F6b): Export ▾'s variant entries (F8).
  const variantList = trpc.course.variantList.useQuery({ courseId: selectedCourse?.id ?? 1 }, { enabled: !!selectedCourse && hasGroups });
  // The keys of the structure being edited (a new key has no runners until the write lands and they are dealt).
  const exportVariants = useMemo(() => {
    const counts = new Map((variantList.data ?? []).map((v) => [v.variantKey, v.runnerCount]));
    return variantKeys.map((key) => ({ key, runnerCount: counts.get(key) ?? 0 }));
  }, [variantKeys, variantList.data]);
  // The selected course's classes: Class view's picker (docs/course-layout.md §6).
  const courseClasses = trpc.layout.classOverrides.useQuery(
    { courseId: selectedCourse?.id ?? 1 },
    { enabled: !!selectedCourse },
  );

  // Sites this client created since the last refetch: their kind, position and code, for the writes and the
  // ghost that follow before `controlCoordinates` / `control.list` have them (§6.1).
  const created = useRef(new Map<number, { kind: "control" | "start" | "finish"; pt: Pt; code: number | null; mark?: boolean }>());
  useEffect(() => {
    if (pendingOps === 0) created.current.clear();
  }, [controlCoords.data, controlList.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const kindOfLatest: KindOf = useCallback((id: number) => created.current.get(id)?.kind ?? kindOf(id), [kindOf]);

  // The latest values for writes queued behind each other (a chain of placements runs one at a time).
  const latest = useRef({ detailStructure, detailVersion: detail.data?.version ?? null, selectedCourse, sites, kindOf: kindOfLatest, rows, siteKindOf, isMark, orders });
  latest.current = { detailStructure, detailVersion: detail.data?.version ?? null, selectedCourse, sites, kindOf: kindOfLatest, rows, siteKindOf, isMark, orders };

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

  // ─── The selected leg (§6.7): the leg-click phantom on the selected course ──
  const selectedLeg = useMemo(() => {
    const insertAt = state.phantom?.insertAt;
    if (insertAt == null || !structure || state.mode !== "course" || state.view === "all" || state.view === "all-variations" || structure.orderMode !== "ordered") return null;
    const leg = legForInsert(rows, insertAt);
    // A loop's anchor visit has no item, so no leg props (§12).
    const item = leg && explicit ? itemAtPath(explicit, leg.path) : undefined;
    if (!leg || !leg.from.pt || !leg.to.pt || !item) return null;
    return { itemIndex: leg.itemIndex, path: leg.path, from: leg.from, to: leg.to, fromPt: leg.from.pt, toPt: leg.to.pt, props: item.leg ?? {} };
  }, [state.phantom, state.mode, state.view, structure, rows, explicit]);
  /** Leg editing is desktop and tablet; the phone shows the section read-only (08 §5.5). */
  const legEditable = !!selectedLeg && !isMobile;
  /** One leg edit: a patch of the item's `LegProps`, one `setStructure`, one undo entry. False when nothing was written. */
  const writeLeg = useCallback((patch: LegPatch): Promise<boolean> => {
    if (!selectedLeg) return Promise.resolve(false);
    const path = selectedLeg.path;
    return applyStructure((s) => setLegProps(s, path, patch));
  }, [selectedLeg, applyStructure]);
  /** The selected leg's identity: its course, item and sites (F21: a live draft belongs to one). */
  const legIdentity = selectedLeg && selectedCourse ? `${selectedCourse.id}/${selectedLeg.itemIndex}/${selectedLeg.from.id}>${selectedLeg.to.id}` : null;
  /**
   * The selected leg's live bends while a bend or grip drag is in flight (§6.7, F21): the layer redraws the course per
   * move. `live` during the drag, shown while its leg is selected; `held` from the release, shown until the course drawn
   * under it carries the written bends or leaves the ones it showed at the release (the `pendingMoves` rule), so the
   * band does not jump back while the list catches up. Dropped on a cancelled drag, Escape and a failed write; undo /
   * redo (`moveEpoch`) end it. `shownLegDraft` (below the course override) applies these rules (`shownLegDraftOf`).
   */
  const [legDraft, setLegDraft] = useState<HeldLegDraft | null>(null);
  /** The bends the canvas draws for a course's leg without a draft (set below, once the override is known). */
  const drawnLegBendsRef = useRef<(course: string, key: string) => readonly Bend[] | undefined>(() => undefined);
  const draftLegBends = useCallback((bends: Bend[] | null) => {
    if (!bends) return setLegDraft((d) => (d?.phase === "live" ? null : d));
    if (!selectedLeg || !selectedCourse || !legIdentity) return;
    setLegDraft({ course: selectedCourse.name, key: `${selectedLeg.from.id}>${selectedLeg.to.id}`, bends, leg: legIdentity, phase: "live", epoch: moveEpoch });
  }, [selectedLeg, selectedCourse, legIdentity, moveEpoch]);
  /** A bend gesture's one write (a drag's release, an Alt-click): its bends held as a draft until the list has them. */
  const writeLegBends = useCallback((bends: Bend[]) => {
    if (!selectedLeg || !selectedCourse || !legIdentity) return;
    const key = `${selectedLeg.from.id}>${selectedLeg.to.id}`;
    const draft: HeldLegDraft = { course: selectedCourse.name, key, bends, leg: legIdentity, phase: "held", from: drawnLegBendsRef.current(selectedCourse.name, key), epoch: moveEpoch };
    setLegDraft(draft);
    void writeLeg({ bends }).then((ok) => { if (!ok) setLegDraft((d) => (d === draft ? null : d)); });
  }, [selectedLeg, selectedCourse, legIdentity, writeLeg, moveEpoch]);
  /** The selected leg's focused bend (a click on its handle or row): `Delete` removes it. Keyed by the leg's item. */
  const [bendFocus, setBendFocus] = useState<{ itemIndex: number; index: number } | null>(null);
  const focusedBend = bendFocus && selectedLeg && bendFocus.itemIndex === selectedLeg.itemIndex && bendFocus.index < (selectedLeg.props.bends?.length ?? 0)
    ? bendFocus.index : null;
  const focusBend = useCallback((index: number | null) => {
    setBendFocus(index === null || !selectedLeg ? null : { itemIndex: selectedLeg.itemIndex, index });
  }, [selectedLeg]);
  /** *Add bend here* (§6.7, F16): a smooth bend on the leg at the phantom; Alt held on the click, a corner. Focused. */
  const addBend = useCallback((e?: { altKey?: boolean }) => {
    const p = state.phantom;
    if (!selectedLeg || !p) return;
    const { bends, index } = insertBendAt(selectedLeg.fromPt, selectedLeg.props.bends, selectedLeg.toPt, { x: p.x, y: p.y }, !!e?.altKey);
    writeLeg({ bends });
    setBendFocus({ itemIndex: selectedLeg.itemIndex, index });
  }, [state.phantom, selectedLeg, writeLeg]);
  /** The bend row's **Smooth** / **Corner** (§6.7, tablets): one write. */
  const setBendCurve = useCallback((index: number, kind: "smooth" | "corner") => {
    if (!selectedLeg) return;
    const before = selectedLeg.props.bends ?? [];
    const bends = setBendKind(selectedLeg.fromPt, before, selectedLeg.toPt, index, kind);
    if (bends.some((b, i) => b !== before[i])) writeLeg({ bends });
  }, [selectedLeg, writeLeg]);
  // ─── Variation authoring (§12; 08 §5.3) ──────────────────
  /** *Create variation here*: on a selected top-level leg in Course view, desktop and tablet. */
  const variationHere = legEditable && state.view === "course" && !!explicit && !!state.phantom && state.phantom.insertAt !== null
    && canCreateGroup(explicit, state.phantom.insertAt, kindOf, orders);
  const createVariation = useCallback(() => {
    const at = state.phantom?.insertAt;
    if (at == null) return;
    let made: string | null = null;
    void applyStructure((s) => {
      const out = createGroup(s, at, latest.current.kindOf, latest.current.orders);
      made = out?.groupId ?? null;
      return out?.structure ?? s;
    }).then((ok) => {
      // The new group's A is displayed and active: `K` places into it (§12).
      if (ok && made) dispatch({ type: "alternative", groupId: made, label: "A" });
    });
  }, [state.phantom, applyStructure]);
  /** One group edit: one `setStructure`, one undo entry. */
  const editGroup = useCallback((fn: (s: Structure) => Structure) => { void applyStructure(fn); }, [applyStructure]);
  const variationHandlers = useMemo(() => ({
    readOnly: isMobile,
    onTab: (groupId: string, label: string) => dispatch({ type: "alternative", groupId, label }),
    onAdd: (groupId: string) => {
      let label: string | null = null;
      void applyStructure((s) => {
        const out = addAlternative(s, groupId);
        label = out?.label ?? null;
        return out?.structure ?? s;
      }).then((ok) => { if (ok && label) dispatch({ type: "alternative", groupId, label }); });
    },
    onRemove: (groupId: string, label: string) => editGroup((s) => removeAlternative(s, groupId, label)),
    onRename: (groupId: string, label: string, next: string) => {
      void applyStructure((s) => renameAlternative(s, groupId, label, next)).then((ok) => {
        if (ok) dispatch({ type: "alternative", groupId, label: next.trim() });
      });
    },
    onLoop: (groupId: string, loop: boolean) => editGroup((s) => setLoop(s, groupId, loop)),
    onMoveTo: (seqIndex: number, groupId: string, label: string) =>
      editGroup((s) => moveToAlternative(s, seqIndex, groupId, label, latest.current.kindOf, latest.current.orders)),
  }), [isMobile, applyStructure, editGroup]);
  /** The group the selection is in (a row, a leg into a group row, or the last activated): `1–9` picks its alternative. */
  const selectionGroup = useMemo(() => {
    const legRow = selectedLeg ? rows[selectedLeg.itemIndex] : undefined;
    const selRow = state.selectedControlId !== null ? rows.find((r) => r.id === state.selectedControlId && r.group) : undefined;
    const id = legRow?.group?.id ?? selRow?.group?.id ?? state.focusGroupId;
    return id ? blocks.find((b) => b.id === id) ?? null : null;
  }, [selectedLeg, rows, state.selectedControlId, state.focusGroupId, blocks]);
  /** `K` with an alternative activated and nothing selected (§12): the end of that alternative. */
  const focusInsertAt = useMemo(() => {
    const b = state.focusGroupId ? blocks.find((x) => x.id === state.focusGroupId) : undefined;
    return b && state.view === "course" ? alternativeEndAt(rows, b.itemIndex, b.active) : null;
  }, [state.focusGroupId, state.view, blocks, rows]);

  const canCorridor = legEditable && !selectedLeg?.props.corridor;
  const addCorridor = useCallback(() => { if (canCorridor) writeLeg({ corridor: DEFAULT_CORRIDOR }); }, [canCorridor, writeLeg]);

  /**
   * Description instructions (§4): the value this client wrote last, until `course.list` has it (a second
   * edit right after the first builds on the first); `version` is null while the write is in flight.
   */
  const [localInstructions, setLocalInstructions] = useState<{ courseId: number; value: Instructions; version: string | null } | null>(null);
  const instructionsBase: Instructions =
    localInstructions && selectedCourse && localInstructions.courseId === selectedCourse.id &&
    (localInstructions.version === null || BigInt(selectedCourse.version) < BigInt(localInstructions.version))
      ? localInstructions.value
      : selectedCourse?.descriptionInstructions ?? null;
  const shownInstructions = useMemo(() => instructionsOnCourse(instructionsBase, sequenceIds), [instructionsBase, sequenceIds]);
  /**
   * One instructions write — a gesture, its undo or its redo: the value shows at once and until `course.list`
   * carries it; refused, it is dropped (the refetch shows the stored one). Layout mode's block reads the
   * course's value through `resolveSheet`, so that is refetched.
   */
  const writeInstructions = useCallback(async (courseId: number, value: Instructions) => {
    setLocalInstructions({ courseId, value, version: null });
    const mine = (l: typeof localInstructions) => !!l && l.courseId === courseId && l.value === value;
    try {
      const res = await writes.setInstructions(courseId, value);
      setLocalInstructions((l) => (mine(l) ? { ...l!, version: res.version } : l));
      void utils.courseMap.resolveSheet.invalidate();
      return res;
    } catch (e) {
      setLocalInstructions((l) => (mine(l) ? null : l));
      throw e;
    }
  }, [writes, utils]);
  /**
   * Gestures queue behind each other (§3: a write sends its predecessor's token); a gesture queued behind
   * one that was refused is dropped with it, since it was built on the refused value.
   */
  const instructionsQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  // `next` was built from this render's `shownInstructions` (the block's prop), so that is the value it replaces.
  const handleInstructions = useCallback((next: Instructions) => {
    const course = selectedCourse;
    const prev = shownInstructions;
    if (!course || JSON.stringify(prev) === JSON.stringify(next)) return;
    setLocalInstructions({ courseId: course.id, value: next, version: null });
    const redo = () => writeInstructions(course.id, next);
    instructionsQueue.current = instructionsQueue.current.then(async (predecessorOk) => {
      if (!predecessorOk) {
        setLocalInstructions((l) => (l && l.value === next ? null : l));
        return true;
      }
      if ((await run(redo)) === undefined) return false;
      record(() => writeInstructions(course.id, prev), redo);
      return true;
    });
  }, [selectedCourse, shownInstructions, writeInstructions, run, record]);

  /**
   * Create a site at `pt` — a control (code from the club allocation; SRR codes get radio) or a code-less
   * start / finish — and, with a course, write `edit(base, id)` into its structure: one undo entry (§4, §6.1).
   */
  const createSite = useCallback(async (pt: Pt, kind: "control" | "start" | "finish" | "crossing_point" | "map_issue" | "map_exchange", edit: ((s: Structure, id: number) => Structure) | null): Promise<number | null> => {
    let code: number | null = null;
    let srr = false;
    // A map exchange takes a code like a control (§6.9).
    if (kind === "control" || kind === "map_exchange") {
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
    const made = await run(() => (kind === "control" || kind === "map_exchange"
      ? client.control.create.mutate({ codes: String(code), status: 0, xpos: pt.x, ypos: pt.y, autoDescribe: true, ...(kind === "map_exchange" ? { kind } : {}) })
      : kind === "start" || kind === "finish"
        ? client.control.create.mutate({ status: kind === "start" ? 4 : 5, xpos: pt.x, ypos: pt.y })
        // Code-less, named "Passeringspunkt N" / "Kartutdelning N" by the server (course-layer.md §6.3).
        : client.control.create.mutate({ kind, xpos: pt.x, ypos: pt.y })));
    if (!made) return null;
    const id = made.id;
    created.current.set(id, { kind: kind === "start" || kind === "finish" ? kind : "control", pt, code, ...(kind === "crossing_point" || kind === "map_issue" ? { mark: true } : {}) });
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
    const id = await createSite(pt, "control", insertAt !== null ? (s, newId) => insertSite(s, insertAt, newId, kindOfLatest, latest.current.orders) : null);
    if (id !== null) dispatch({ type: "placed", id });
  }, [createSite, kindOfLatest]);

  /** A code-less start / finish (named "Start N" / "Mål N" by the server), or a free map-issue point (§6.8). */
  const createRoleControl = useCallback(async (pt: Pt, role: "start" | "finish" | "map_issue") => {
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
    setBendFocus(null);
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
  const updateField = useCallback((id: number, patch: { kind?: ControlKind; notes?: string }, prev: typeof patch) => {
    void (async () => {
      const redo = () => writes.updateControl({ id, ...patch });
      if ((await run(redo)) === undefined) return;
      record(() => writes.updateControl({ id, ...prev }), redo);
    })();
  }, [writes, run, record]);

  /** Check-off (§9; `courses.review`): one write, one undo entry (undo is the opposite check). */
  const checkControl = useCallback((id: number, checked: boolean) => {
    void (async () => {
      const redo = () => writes.checkControl(id, checked);
      if ((await run(redo)) === undefined) return;
      record(() => writes.checkControl(id, !checked), redo);
    })();
  }, [writes, run, record]);

  /**
   * The nudge pad (§9): each press is one move with undo, queued behind the previous so presses faster than
   * the refetch build on each other; `nudged` holds the newest position until `controlCoordinates` has it.
   */
  const [nudged, setNudged] = useState<{ id: number; pt: Pt } | null>(null);
  const nudgeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const nudgeTo = useCallback((id: number, from: Pt, to: Pt) => {
    setNudged({ id, pt: to });
    setLastMovedId(id);
    const description = coordsById.get(id)?.description ?? null;
    nudgeQueue.current = nudgeQueue.current.then(async () => {
      const redo = () => writes.updateControl({ id, xpos: to.x, ypos: to.y, autoDescribe: true }, from);
      if ((await run(redo, { controlId: id, mine: to })) === undefined) { setNudged(null); return; }
      record(() => writes.updateControl({ id, xpos: from.x, ypos: from.y, description }), redo);
    }).catch(() => {});
  }, [writes, run, record, coordsById]);
  useEffect(() => {
    if (!nudged) return;
    const c = coordsById.get(nudged.id);
    if (state.selectedControlId !== nudged.id || (c && Math.abs(c.mapX - nudged.pt.x) < 1e-6 && Math.abs(c.mapY - nudged.pt.y) < 1e-6)) setNudged(null);
  }, [nudged, coordsById, state.selectedControlId]);

  // ─── Course objects (§7) ─────────────────────────────────
  const objects = useMemo(() => objectList.data ?? [], [objectList.data]);
  const highlighted = useMemo(() => new Set(state.view !== "all" && selectedCourse ? [selectedCourse.name] : []), [state.view, selectedCourse]);
  const objectsInView = useMemo(() => courseObjectsForView(objects, highlighted, courses.data ?? []), [objects, highlighted, courses.data]);
  const selectedObject = state.selectedObjectId !== null ? objects.find((o) => o.id === state.selectedObjectId) ?? null : null;
  /** Geometry being dragged (vertex or body) or drawn, drawn instead of the stored one until the list catches up. */
  const [drafts, setDrafts] = useState<Map<number, CourseObject["geometry"]>>(new Map());
  useEffect(() => { setDrafts((d) => (d.size ? new Map() : d)); }, [objectList.data]);
  /** The selected object's focused vertex (a click on its handle): `Delete` removes it (§7 "Editing geometry"). */
  // Keyed by the object it belongs to, so a selection change drops it.
  const [focus, setFocus] = useState<{ objectId: number; index: number } | null>(null);
  const focusedVertex = focus && focus.objectId === state.selectedObjectId ? focus.index : null;
  const selectedObjectId = state.selectedObjectId;
  const setFocusedVertex = (index: number | null) =>
    setFocus(index === null || selectedObjectId === null ? null : { objectId: selectedObjectId, index });
  /** Per object, the geometry shown when the gesture in progress drew its first draft (`onObjectDraft`). */
  const gestureBefore = useRef(new Map<number, CourseObject["geometry"]>());
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

  // ─── The filter region's symbol list and eyedropper (§6.4, §7) ─────
  const filterSelected = selectedObject?.kind === "filter_region";
  const pickIndex = useMemo(() => (filterSelected && mapDoc ? pickIndexForDocument(mapDoc.hash, mapDoc.bytes) : null), [filterSelected, mapDoc]);
  const filterGroups = useMemo(
    () => (pickIndex && mapDoc ? symbolGroups(mapDoc.header, pickIndex.objectsPerSymbol, i18n.language) : null),
    [pickIndex, mapDoc, i18n.language],
  );
  /** What the last pick did, for the region it was made on. */
  const [pickNote, setPickNote] = useState<{ objectId: number; note: { kind: "added" | "already"; label: string } | { kind: "miss" } } | null>(null);
  /** The props the last pick wrote, until the stored object catches up: consecutive picks build on each other. */
  const pickBase = useRef<{ id: number; version: string; props: CourseObject["props"] } | null>(null);
  const pickAt = useCallback((pt: Pt, toleranceMm: number) => {
    const o = selectedObject;
    if (o?.kind !== "filter_region" || !pickIndex || !filterGroups || !mapDoc) return;
    const base = (pickBase.current?.id === o.id && pickBase.current.version === o.version ? pickBase.current.props : o.props) as typeof o.props;
    const hit = pickIndex.symbolAt(pt, toleranceMm);
    let next: typeof o.props | null = null;
    let label = "";
    if (hit && typeof base.symbols === "object" && !Array.isArray(base.symbols)) {
      // Colours mode: the colour of the pass under the click joins.
      if (hit.colour !== null) {
        next = { ...base, symbols: { colours: [...new Set([...base.symbols.colours, hit.colour])].sort((a, b) => a - b) } };
        label = mapDoc.header.colours[hit.colour]?.name ?? String(hit.colour);
      }
    } else if (hit) {
      // The hit symbol's whole group joins (§7: one entry per heading); "all" becomes a pick of that group.
      const g: SymbolGroup | null = groupOfSymbol(filterGroups, hit.symbolIdx);
      if (g) {
        const cur = Array.isArray(base.symbols) ? base.symbols : [];
        next = { ...base, symbols: [...new Set([...cur, ...g.members])].sort((a, b) => a - b) };
        label = `${g.code} ${g.name}`;
      }
    }
    if (!next) { setPickNote({ objectId: o.id, note: { kind: "miss" } }); return; }
    if (JSON.stringify(next.symbols) === JSON.stringify(base.symbols)) { setPickNote({ objectId: o.id, note: { kind: "already", label } }); return; }
    setPickNote({ objectId: o.id, note: { kind: "added", label } });
    pickBase.current = { id: o.id, version: o.version, props: next };
    updateObject({ ...o, props: base } as CourseObject, { props: next });
  }, [selectedObject, pickIndex, filterGroups, mapDoc, updateObject]);

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
  /** F27: the placement loupe toggle (top-bar magnifier, the phone's overflow, `L`) — a per-browser preference, off by default. */
  const [placementLoupe, setPlacementLoupe] = useLocalStorage(PLACEMENT_LOUPE_KEY, false);
  const togglePlacementLoupe = useCallback(() => setPlacementLoupe((v) => !v), [setPlacementLoupe]);
  const onHover = useCallback((p: ToolPointer | null) => {
    setHover((prev) => {
      if (!p) return prev === null ? prev : null;
      const pt = snap(p.pt);
      const same = prev && Math.abs(prev.pt.x - pt.x) < 1e-6 && Math.abs(prev.pt.y - pt.y) < 1e-6 && prev.target?.kind === p.target?.kind
        && (prev.target as { id?: unknown } | null)?.id === (p.target as { id?: unknown } | null)?.id;
      return same ? prev : { pt, target: p.target };
    });
  }, [snap]);

  // §12: with an alternative activated and nothing selected, a visit tool starts at the end of that alternative.
  const armContext = useCallback((tool?: PlacementTool) => ({
    rows, course: !!(selectedCourse && structure), selectedControlId: state.selectedControlId,
    legInsertAt: state.phantom?.insertAt
      ?? (tool !== undefined && isVisitTool(tool) && state.selectedControlId === null ? focusInsertAt : null),
  }), [rows, selectedCourse, structure, state.selectedControlId, state.phantom, focusInsertAt]);

  const setTool = useCallback((tool: EditorTool) => {
    gesture.current = null;
    chainRef.current = tool.kind === "place" ? tool.chain : null;
    setHover(null);
    dispatch({ type: "tool", tool });
  }, []);

  const armPlace = useCallback((tool: PlacementTool) => {
    const current = chainRef.current;
    const chain = current ? switchTool(current, tool, armContext(tool)) : armPlacement(tool, armContext(tool));
    setTool({ kind: "place", chain });
  }, [armContext, setTool]);

  const exitTool = useCallback(() => setTool({ kind: "select" }), [setTool]);
  // The eyedropper belongs to the selected filter region (§6.4): another selection ends it.
  useEffect(() => { if (state.tool.kind === "pick-symbol" && !filterSelected) exitTool(); }, [state.tool.kind, filterSelected, exitTool]);

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
      if (chain.tool === "crossing") {
        // §6.8: on a selected leg the site is created (or an existing crossing point reused) and the leg
        // routed through it, one undo entry; without a leg a free site.
        const legAt = chain.insertAt;
        const leg = legAt !== null ? legForInsert(latest.current.rows, legAt) : null;
        const route = leg ? (s: Structure, siteId: number) => setLegProps(s, leg.path, { crossing: { controlId: siteId } }) : null;
        if (targetId !== null) {
          if (latest.current.siteKindOf(targetId) !== "crossing_point") return;
          if (!route) { dispatch({ type: "select", id: targetId }); return; }
          if (!(await applyStructure((s) => route(s, targetId)))) return;
          id = targetId;
        } else {
          id = await createSite(pt, "crossing_point", route);
        }
      } else if (isVisitTool(chain.tool)) {
        // `K` reuses a control (an exchange too: it is one), `X` only an exchange (§6.9).
        const exchange = chain.tool === "exchange";
        if (targetId !== null) {
          if (targetKind !== "control" || latest.current.isMark(targetId)) return;
          if (exchange && latest.current.siteKindOf(targetId) !== "map_exchange") return;
          // Reuse the site: into the course at the insertion point, no new site.
          if (chain.insertAt === null) { dispatch({ type: "select", id: targetId }); return; }
          const at = chain.insertAt;
          if (!(await applyStructure((s) => insertSite(s, at, targetId, kindOfL, latest.current.orders)))) return;
          id = targetId;
        } else {
          const at = chain.insertAt;
          id = await createSite(pt, exchange ? "map_exchange" : "control", at !== null ? (s, newId) => insertSite(s, at, newId, kindOfL, latest.current.orders) : null);
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
      if (endsChain(chain)) exitTool(); // a finish ends the chain, as does a crossing point on a leg
      else setChain(next);
    }).catch(() => {});
  }, [snap, applyStructure, createSite, setChain, exitTool, undoStack]);

  /** `A` → a kind: the polygon flow, or the toner saver's hull from the course straight away. */
  const startArea = useCallback((kind: AreaChoice) => {
    if (kind !== "toner_saver") return setTool(areaTool(kind));
    const pts = rows.flatMap((r) => (r.pt ? [r.pt] : []));
    const hull = tonerSaverGeometry(pts, TONER_MARGIN_MM);
    if (!hull || !selectedCourse) return;
    void (async () => {
      const id = await createObject({ kind: "toner_saver", geometry: hull, props: { marginMm: TONER_MARGIN_MM }, scope: { courses: [selectedCourse.id], classes: [] } });
      setTool({ kind: "select" });
      if (id !== null) dispatch({ type: "select-object", id });
    })();
  }, [rows, selectedCourse, createObject, setTool]);

  const finishArea = useCallback((kind: AreaKind, vertices: Vertex[]) => {
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
    const leg = legForInsert(rows, insertAt);
    const fromPt = leg?.from.pt, toPt = leg?.to.pt;
    if (!leg || !fromPt || !toPt) return null;
    const { itemIndex, from, to } = leg;
    // A loop's anchor visit has no item (§12): no leg target rather than another item's leg.
    const item = explicit ? itemAtPath(explicit, leg.path) : undefined;
    if (!item) return null;
    const stored = item.leg?.gaps ?? [];
    const via = crossingPt(item.leg);
    const bends = via ? courseShared.routedBends(fromPt, item.leg?.bends, via, toPt) : item.leg?.bends;
    const effective = courseInfo?.derivation?.courses[0]?.legs.find((l) => l.from === String(from.id) && l.to === String(to.id))?.gaps ?? [];
    // Fractions of the bent length (§6.3): the target is the leg's polyline through its bends.
    return { kind: "leg", itemIndex, points: legPolyline(fromPt, bends, toPt), gaps: stored.length ? stored : effective, stored: stored.length > 0 };
  }, [courseInfo, state.selectedControlId, state.phantom, state.tool, coordsById, kindOf, controlRowsById, structure, rows, explicit, crossingPt]);

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
      // The target's row (its index) names the leg's item by its path (§12).
      const path = latest.current.rows[target.itemIndex]?.path;
      if (path) void applyStructure((s) => setLegGaps(s, path, gaps as FractionGap[]));
    }
  }, [controlRowsById, writes, run, record, applyStructure]);

  // The ghost's description: the top autodetect candidate under the cursor (08 §5.3), asked once the pointer rests.
  const [ghostAsk, setGhostAsk] = useState<Pt | null>(null);
  const placing = state.tool.kind === "place" ? state.tool.chain : null;
  useEffect(() => {
    if (!placing || !isVisitTool(placing.tool) || !hover || hover.target) { setGhostAsk(null); return; }
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
    const crossing = placing.tool === "crossing";
    const reusable = (id: number) => (crossing
      ? siteKindOf(id) === "crossing_point"
      : placing.tool === "exchange"
        ? siteKindOf(id) === "map_exchange"
        : !isMark(id) && kindOfLatest(id) === placing.tool);
    const reuse = reuseId !== null && reusable(reuseId) ? reuseId : null;
    const at = reuse !== null ? ptOf(reuse) ?? hover.pt : hover.pt;
    const info = ghostInfo(placing, rows, at, ptOf);
    const radiusMm = placing.tool === "finish" ? courseInfo?.metrics?.finishRadiusMm ?? 3 : placing.tool === "start" ? courseInfo?.metrics?.startRadiusMm ?? 3.5 : courseInfo?.metrics?.circleRadiusMm ?? 2.5;
    const code = reuse !== null ? coordsById.get(reuse)?.code ?? String(reuse) : null;
    const label = reuse !== null
      ? t("ghostReuse", { code })
      : isVisitTool(placing.tool)
        ? [info.number !== null ? String(info.number) : null, nextCode !== null ? String(nextCode) : null].filter(Boolean).join(" · ")
        : t(placing.tool === "start" ? "kindStart" : placing.tool === "crossing" ? "kind_crossing_point" : "kindFinish");
    const legLabel = info.legs[0] ? legLengthLabel(info.legs[0][0], info.legs[0][1], mapScale) : null;
    // §6.8: the ghost 710 turns along the selected leg's segment nearest the cursor; north without a leg.
    let angleDeg: number | undefined;
    if (crossing && placing.insertAt !== null) {
      const leg = legForInsert(rows, placing.insertAt);
      const item = leg && explicit ? itemAtPath(explicit, leg.path) : undefined;
      if (leg?.from.pt && leg.to.pt) {
        const pts = legPolyline(leg.from.pt, item?.leg?.bends, leg.to.pt);
        const near = projectOnPolyline(pts, at);
        if (near) {
          const a = pts[near.segment], b = pts[near.segment + 1];
          angleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        }
      }
    }
    const role = crossing ? "crossing_point" as const : isVisitTool(placing.tool) ? "control" as const : placing.tool as "start" | "finish";
    return { at, radiusMm, role, angleDeg, label, description: reuse === null && !crossing ? ghostDescription : null, legs: info.legs, legMm: info.legMm, legLabel, reuse };
  }, [placing, hover, kindOfLatest, siteKindOf, isMark, ptOf, rows, explicit, courseInfo, coordsById, t, nextCode, ghostDescription, mapScale]);

  // The visit the click would write, drawn by the layer (§6.1): one course request per hover. Keyed by
  // primitives: the ghost itself changes with every course reply (its radius), which must not re-request.
  const ghostX = ghost?.at.x, ghostY = ghost?.at.y, ghostReuse = ghost?.reuse ?? null;
  const provisional = useMemo((): ProvisionalVisit | null => {
    // A crossing point is no visit (§6.8): the layer draws nothing provisional for it.
    if (!placing || placing.tool === "crossing" || placing.insertAt === null || ghostX === undefined || ghostY === undefined) return null;
    return {
      role: placing.tool === "exchange" ? "map_exchange" : placing.tool, insertAt: placing.insertAt, pt: { x: ghostX, y: ghostY },
      ...(ghostReuse !== null ? { reuseId: String(ghostReuse) } : { code: nextCode !== null ? String(nextCode) : "" }),
    };
  }, [placing, ghostX, ghostY, ghostReuse, nextCode]);

  const sitesForTools = useMemo(() => sites.filter((x) => x.mapX !== 0 || x.mapY !== 0)
    .map((x) => ({ id: x.id, x: x.mapX, y: x.mapY, kind: kindOf(x.id) })), [sites, kindOf]);

  // All variations' numbers (F15): the items the layer numbers — role control, positioned.
  const positionedIds = useMemo(() => new Set(sitesForTools.map((x) => x.id)), [sitesForTools]);

  const insertOnLeg = useCallback((target: { courseId: string; index: number }, pt: Pt) => {
    // All variations is a read-only overlay (§12): its spine's legs are not the rows'.
    if (!selectedCourse || target.courseId !== selectedCourse.name || state.view === "all-variations") return;
    void createControl(snap(pt), insertIndexForLeg(rows, target.index));
  }, [selectedCourse, rows, createControl, snap, state.view]);

  const courseView = state.view !== "all";
  /** The one course the layer highlights — and the only one it splices the provisional visit into. */
  const highlightCourseName = courseView ? selectedCourse?.name : undefined;

  const tool = state.tool;
  const toolBinding: EditorToolBinding | null = (() => {
    switch (tool.kind) {
      case "place":
        // The layer draws the visit only under the highlighted course (Course / Class view).
        return placeBinding({
          ghost, provisionalDrawn: !!highlightCourseName && provisionalDrawn(provisional),
          onHover, onPlace: place, onExit: exitTool, touch: { placeLabel: t("touchPlace"), doneLabel: t("touchDone") },
        });
      case "area":
        return areaBinding({
          gesture, poly: tool.poly, hover: hover?.pt ?? null, onHover, snap,
          onPoly: (poly) => dispatch({ type: "polygon", poly }),
          onDone: (vertices) => finishArea(tool.poly.kind, vertices),
          onCancel: exitTool,
        });
      case "text":
        return textBinding({ onPlace: placeText, onExit: exitTool, snap, hover: hover?.pt ?? null, onHover });
      case "pick-symbol":
        return pickIndex ? pickSymbolBinding({ onPick: pickAt, onExit: exitTool }) : null;
      case "gap":
        return gapTarget ? gapBinding({
          gesture, target: gapTarget, redraw,
          onAdd: (gap) => writeGaps(gapTarget, gapTarget.kind === "circle" ? mergeCircleGaps([...gapTarget.gaps, gap as AngularGap]) : mergeLegGaps([...gapTarget.gaps, gap as FractionGap])),
          onRemove: (i) => writeGaps(gapTarget, (gapTarget.gaps as (AngularGap | FractionGap)[]).filter((_, k) => k !== i) as AngularGap[] | FractionGap[]),
          onExit: exitTool,
        }) : null;
      case "select":
        return selectBinding({
          gesture, redraw, selected: selectedObject, focusedVertex, onVertexFocus: setFocusedVertex, objects: objectsInView.map((o) => (drafts.has(o.id) ? { ...o, geometry: drafts.get(o.id)! } : o)),
          sites: sitesForTools, multi: state.multi, ringMm: courseInfo?.metrics?.circleRadiusMm ?? 2.5,
          onToggleMulti: (id) => dispatch({ type: "toggle-multi", id }),
          onLasso: (ids) => dispatch({ type: "set-multi", ids }),
          onSelectObject: (id) => dispatch({ type: "select-object", id }),
          onObjectDraft: (id, geometry) => {
            // The first draft of a gesture keeps what was shown before it: the undo's "before".
            if (geometry && !gestureBefore.current.has(id)) gestureBefore.current.set(id, drafts.get(id) ?? objects.find((x) => x.id === id)?.geometry ?? geometry);
            if (!geometry) gestureBefore.current.delete(id);
            setDraft(id, geometry);
          },
          onObjectMoved: (id, geometry) => {
            const o = objects.find((x) => x.id === id);
            // Undo restores what the gesture started from — a previous gesture's draft while the list catches up.
            const before = gestureBefore.current.get(id) ?? drafts.get(id) ?? o?.geometry;
            gestureBefore.current.delete(id);
            setDraft(id, geometry);
            if (o && before) updateObject({ ...o, geometry: before } as CourseObject, { geometry });
          },
          onLegDoubleClick: insertOnLeg,
          leg: legEditable && selectedLeg ? {
            from: selectedLeg.fromPt, to: selectedLeg.toPt, bends: selectedLeg.props.bends ?? [], focused: focusedBend,
            onBendsChange: writeLegBends, onBendsDraft: draftLegBends, onBendFocus: focusBend, snap,
          } : null,
        });
    }
  })();

  // §6.7 (F14): the layer draws no line inside a corridor, so a blue dashed guide marks every corridor leg of the
  // selected course wherever its legs are clickable (Course mode; Course / Class / Variant view), whatever the tool.
  // The selected leg's own outline (V, desktop and tablet) replaces its guide.
  const outlinedLegAt = state.tool.kind === "select" && legEditable ? state.phantom?.insertAt ?? null : null;
  const corridorGuides = useMemo((): CorridorGuide[] => {
    if (state.mode !== "course" || !selectedCourse || !courseView || state.view === "all-variations") return [];
    const derived = courseInfo?.derivation?.courses.find((c) => c.id === selectedCourse.name);
    return (derived?.legs ?? []).flatMap((l, index) =>
      l.corridor && l.points.length >= 2 && !(outlinedLegAt !== null && insertIndexForLeg(rows, index) === outlinedLegAt)
        ? [{ course: derived!.id, index, points: l.points }] : []);
  }, [state.mode, state.view, selectedCourse, courseView, courseInfo, rows, outlinedLegAt]);
  const shownBinding = withCorridorGuides(toolBinding, corridorGuides);

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

  // ─── The phone's bottom sheet (§10) ──────────────────────
  const [detent, setDetent] = useState<Detent>("peek");
  const [sheetPx, setSheetPx] = useState(0);
  const sheetPxRef = useRef(0);
  sheetPxRef.current = isMobile ? sheetPx : 0;
  /** Centre on `pt`, in the band above the sheet on a phone (§10: the sheet never covers the selection). */
  const centreOn = useCallback((pt: Pt, sheet = sheetPxRef.current) => {
    setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, centre: pt, offsetPx: bandCentreOffsetPx(sheet) }));
  }, []);
  // Field mode centres on the first fix once (the viewer's locate button follows, if the user wants that).
  const centredOnFix = useRef(false);
  useEffect(() => {
    if (!fieldMode) { centredOnFix.current = false; return; }
    if (paperFix && !centredOnFix.current) {
      centredOnFix.current = true;
      centreOn(paperFix);
    }
  }, [fieldMode, paperFix, centreOn]);

  // ─── Checks and KPIs (§8) ────────────────────────────────
  const courseChecks = useCourseChecks({
    course: state.view !== "all" && selectedCourse ? { id: selectedCourse.id, name: selectedCourse.name } : null,
    structure, sites, controls: controlList.data, document: mapDoc, mapScale, objects: objectsInView,
    derivation: courseInfo?.derivation, ringMm: courseInfo?.metrics?.circleRadiusMm ?? 2.5, orders,
  });
  const locateSite = courseChecks.locate;
  const locateCheck = useCallback((c: EditorCheck) => {
    const { selectId, centre } = locateSite(c);
    if (selectId !== null) dispatch({ type: "select", id: selectId });
    if (centre) setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, centre }));
  }, [locateSite]);

  // ─── The action bar ──────────────────────────────────────
  const ends = useMemo(() => (structure ? effectiveEnds(structure, sites) : { start: null, finish: null }), [structure, sites]);
  const contextActions = useMemo(() => {
    // An armed tool opens no action bar (08 §5.3: it would cover the map on every placement).
    if (state.tool.kind !== "select") return [];
    const sel = state.selectedControlId;
    const coord = sel !== null ? coordsById.get(sel) : undefined;
    const role = coord ? kindOf(coord.id) : "control";
    const mark = coord ? isMark(coord.id) : false;
    return courseActions(
      {
        phantom: state.phantom ? { insertAt: state.phantom.insertAt } : null,
        selected: coord ? {
          id: coord.id,
          role,
          onCourse: memberIds.has(coord.id),
          otherRole: role === "start" ? ends.start !== coord.id : role === "finish" ? ends.finish !== coord.id : false,
          hasLabelOffset: !!selectedCourse?.labelOffsets?.[String(coord.id)],
          radioOn: (controlRowsById.get(coord.id)?.config?.radioType ?? "normal") !== "normal",
          swapOffer: radioSwapOffer?.controlId === coord.id,
          mark,
        } : null,
        course: selectedCourse && structure ? selectedCourse.name : null,
        codesReady: !!controlList.data,
        busy: pendingOps > 0,
        legEdit: legEditable,
        variationHere,
      },
      {
        addBend,
        createVariation,
        insert: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, p.insertAt); },
        addToCourse: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, sequenceIds.length); },
        add: () => { const p = state.phantom; if (p) void createControl({ x: p.x, y: p.y }, null); },
        addStart: () => { const p = state.phantom; if (p) void createRoleControl({ x: p.x, y: p.y }, "start"); },
        addFinish: () => { const p = state.phantom; if (p) void createRoleControl({ x: p.x, y: p.y }, "finish"); },
        addMapIssue: () => { const p = state.phantom; if (p) void createRoleControl({ x: p.x, y: p.y }, "map_issue"); },
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
    confirmSwap, declineSwap, handleDelete, tc, legEditable, addBend, isMark, variationHere, createVariation, memberIds]);

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

  /**
   * A course with variation groups as the view shows it (§12): `course.list` has the root's first
   * alternatives, so Course and Variant view draw the displayed path, All variations the spine and the
   * tinted branches. Class view and Layout mode draw the sheet as it prints: one variant (`sheetVariant`, F8).
   */
  const courseOverride = useMemo(() => {
    if (!hasGroups || !selectedCourse || !explicit) return null;
    if (sheetVariant !== null) {
      const v = variants.find((x) => x.key === sheetVariant);
      return v ? [courseDrawOf(selectedCourse.name, displayPath(explicit, kindOf, v.orders).items)] : null;
    }
    if (state.mode === "layout") return null;
    if (state.view === "all-variations") {
      return allVariationDraws(selectedCourse.name, explicit, (item) => (item.role ?? kindOf(item.siteId)) === "control" && positionedIds.has(item.siteId));
    }
    if (state.view !== "course" && state.view !== "variant") return null;
    return [courseDrawOf(selectedCourse.name, displayPath(explicit, kindOf, orders).items)];
  }, [hasGroups, selectedCourse, explicit, state.mode, state.view, kindOf, positionedIds, orders, sheetVariant, variants]);

  // F21: the bends drawn under a leg draft — the override's own draw (a course with groups draws from the structure),
  // else `course.list`'s leg.
  const drawnLegBends = useCallback((name: string, key: string): readonly Bend[] | undefined => {
    const own = courseOverride?.[0]?.name === name ? courseOverride[0] : null;
    return own ? own.legs[key]?.bends : courses.data?.find((c) => c.name === name)?.legs?.[key]?.bends;
  }, [courseOverride, courses.data]);
  useEffect(() => { drawnLegBendsRef.current = drawnLegBends; }, [drawnLegBends]);
  /** The leg draft the viewer draws (§6.7, F21): see `legDraft`. */
  const shownLegDraft = useMemo(
    () => shownLegDraftOf(legDraft, { epoch: moveEpoch, leg: legIdentity, drawn: drawnLegBends }),
    [legDraft, moveEpoch, legIdentity, drawnLegBends],
  );
  // Along the stored bends and the crossing point (course-layer.md §10.1, §10.3; docs/course-editor.md §6.7, §6.8); a
  // leg draft of this course (F21, live or held) in its leg's place, so the metres follow a held bend or grip (F25).
  const meterDraft = shownLegDraft && shownLegDraft.course === selectedCourse?.name ? shownLegDraft : null;
  const legMeters = useMemo(() => sequenceLegMeters(legMeterInputs(rows, (i) => {
    const leg = itemOfRow(i)?.leg;
    return { bends: leg?.bends, via: crossingPt(leg) };
  }, meterDraft), mapScale), [rows, itemOfRow, mapScale, crossingPt, meterDraft]);
  const totalMeters = useMemo(() => legMeters.reduce<number>((sum, m) => sum + (m ?? 0), 0), [legMeters]);

  // Offline, Field mode views only (§9 "Offline"): a drag snaps back instead of writing.
  const fieldReadOnly = fieldMode && !online;
  const fieldMoveEnd = useCallback((id: string, pt: Pt) => {
    if (fieldReadOnly) setMoveEpoch((v) => v + 1);
    else handleMoveEnd(id, pt);
  }, [fieldReadOnly, handleMoveEnd]);

  // Class view is Course view drawn through the class's sheet (docs/course-layout.md §6).
  const fitClassPage = useCallback((bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
    setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, bounds }));
  }, []);
  const classView = useClassView({ enabled: state.mode === "course" && state.view === "class", classSeq: state.classSeq, variantKey: sheetVariant, onFit: fitClassPage });
  const classLayout = classView.layout;
  const courseControlIds = useMemo(() => new Set([...memberIds].map(String)), [memberIds]);
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
    // §10.3: the Course and All-controls views are setter views (702, every crossing point); Class view prints as the class's sheet.
    setterMarks: state.mode === "course" && state.view !== "class",
    moveWarnings,
    moveEpoch,
    onMapClick: handleMapClick,
    onMoveEnd: fieldMoveEnd,
    onLabelMoveEnd: handleLabelMoveEnd,
    onSelect: handleSelect,
    onDismiss: handleDismiss,
    // A phone docks the action bar in the bottom sheet's peek row (§10).
    actionLayout: isMobile ? "host" : "bar",
    fix,
    bottomInsetPx: isMobile ? sheetPx : 0,
    fullBleed: isMobile,
    ...(selectedCourse && courseView && state.view !== "all-variations" ? { onLegClick: handleLegClick } : {}),
    tool: shownBinding,
    placementLoupe,
    snap: snapIndex ? snap : null,
    draftObjects,
    draftFast,
    viewRequest,
    provisional,
    onCourseInfo: setCourseInfo,
    markers: courseChecks.markers,
    layout: classLayout,
    courseOverride,
    legDraft: shownLegDraft,
  }), [shownLegDraft, classLayout, courseChecks.markers, isMobile, fix, sheetPx, fieldMoveEnd, state.selectedControlId, state.phantom, contextActions, contextInfo, srrBadge, radioOn, suggestions, tc, courseControlIds, toolActive,
    courseView, selectedCourse, moveWarnings, moveEpoch, handleMapClick, handleLabelMoveEnd, handleSelect,
    handleDismiss, handleLegClick, shownBinding, placementLoupe, snapIndex, snap, draftObjects, draftFast, viewRequest, provisional, courseOverride, state.view]);

  // Layout mode draws a root's sheet as one variant (F8): its path over the root's first alternatives.
  const layoutEditor = useMemo(
    () => (state.mode === "layout" && courseOverride ? { ...layoutMode.editor, courseOverride } : layoutMode.editor),
    [state.mode, courseOverride, layoutMode.editor],
  );

  // ─── Undo / redo, keyboard, deep links ───────────────────
  const runUndo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    setFocus(null); // its index may name another vertex now
    setBendFocus(null);
    void run(async () => { await undoStack.undo(); bumpHistory(); });
  }, [run, undoStack, bumpHistory]);
  const runRedo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    setFocus(null);
    setBendFocus(null);
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
  const canTonerSaver = !!selectedCourse && rows.some((r) => r.pt);

  const layoutKey = layoutMode.onKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (descControlId !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const plain = !mod && !e.altKey;
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (state.mode === "layout") {
        // Layout mode's own keys (docs/course-layout.md §2); undo / redo are the page's.
        if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) runRedo(); else runUndo(); }
        else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); runRedo(); }
        else if (!layoutKey(e) && e.key === "Escape" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        return;
      }
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
        // A bend or grip drag in flight ends here (§6.7): its draft drops, the release then writes nothing.
        if (gesture.current?.kind === "bend" || gesture.current?.kind === "bend-grip") {
          gesture.current = null;
          redraw();
        }
        setLegDraft((d) => (d?.phase === "live" ? null : d));
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
          // Through the flow, so the minimum and the smooth vertices' settling (flags stripped) have one home.
          const r = polygonStep(state.tool.poly, { type: "enter" });
          if (r.done) finishArea(state.tool.poly.kind, r.done);
        } else if (state.tool.kind !== "select") {
          e.preventDefault();
          exitTool();
        }
      } else if (e.key === "Tab" && !mod) {
        e.preventDefault();
        stepSelection(e.shiftKey ? -1 : 1);
      } else if (areaOpen && plain && areaChoiceOfKey(key)) {
        // The `A` chord: `A` opened the menu, this key picks the kind (§6.4).
        e.preventDefault();
        const kind = areaChoiceOfKey(key)!;
        setAreaOpen(false);
        if (kind !== "toner_saver" || canTonerSaver) startArea(kind);
      } else if (areaOpen && plain && isCorridorKey(key)) {
        // *Corridor on selected leg* (§6.4, §6.7).
        e.preventDefault();
        setAreaOpen(false);
        addCorridor();
      } else if (plain && /^[1-9]$/.test(e.key) && selectionGroup && state.tool.kind === "select") {
        // §12 (08 §5.3): `1–9` on a variation group switches the displayed alternative.
        const label = selectionGroup.labels[Number(e.key) - 1];
        if (label) dispatch({ type: "alternative", groupId: selectionGroup.id, label });
      } else if (plain && key === "H") {
        dispatch({ type: "toggle-hide-others" });
      } else if (plain && key === "L") {
        // F27: the placement loupe toggle (§6 key table, §10 "Loupe").
        togglePlacementLoupe();
      } else if (plain && key === "V") {
        exitTool();
      } else if (plain && (key === "S" || key === "K" || key === "M")) {
        armPlace(key === "S" ? "start" : key === "M" ? "finish" : "control");
      } else if (plain && key === "C") {
        // The crossing point (§6.8); with the `A` menu open, `C` was its corridor entry (above).
        armPlace("crossing");
      } else if (plain && key === "X") {
        // The map exchange (§6.9): a control in the chain.
        armPlace("exchange");
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
        else if (selectedLeg && focusedBend !== null && legEditable) {
          // The selected leg's focused bend (§6.7).
          const bends = selectedLeg.props.bends ?? [];
          writeLeg({ bends: bends.filter((_, i) => i !== focusedBend) });
          setBendFocus(null);
        } else if (selectedObject && focusedVertex !== null) {
          // A focused vertex goes first, down to the kind's minimum; there nothing happens (§7 "Editing geometry").
          const shown = { ...selectedObject, geometry: drafts.get(selectedObject.id) ?? selectedObject.geometry } as CourseObject;
          const geometry = deleteVertex(shown.geometry, focusedVertex, vertexRule(shown.kind).min);
          if (geometry) {
            setDraft(shown.id, geometry);
            updateObject(shown, { geometry });
            setFocus(null);
          }
        } else if (selectedObject) deleteObject(selectedObject);
        else handleDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [descControlId, runUndo, runRedo, undoStack, state, handleDelete, deleteControls, deleteObject, selectedObject, focusedVertex, drafts, setDraft, updateObject, setChain, exitTool, finishArea,
    stepSelection, armPlace, setTool, canGap, fitView, areaOpen, canTonerSaver, startArea, layoutKey, selectedLeg, focusedBend, legEditable, writeLeg, addCorridor, selectionGroup, redraw, togglePlacementLoupe]);

  // ─── The URL (docs/course-editor.md §1 "URL"; F31) ─────────
  // Read once, then taken step by step as the data that checks each param loads: Layout's sheet or template
  // at once (Layout checks it), the course with the course list, the view with the course's classes or
  // structure, an inbound `control=` with the controls. What fails a check stays out of the state. Only then
  // is the URL written, always by `replace` (Back leaves the editor in one step), from the state alone.
  const [hydration, setHydration] = useState<"course" | "view" | "control" | "done">("course");
  const openLayout = layoutMode.open;
  useEffect(() => {
    if (inbound.mode === "layout" && inbound.layout) openLayout(inbound.layout);
  }, [inbound, openLayout]);

  // A sheet opened without a course selected brings its course (it prints only that course).
  const sheetCourse = layoutMode.sheetCourse;
  useEffect(() => {
    if (state.mode === "layout" && sheetCourse !== null && state.selectedCourseId === null) dispatch({ type: "select-course", id: sheetCourse });
  }, [state.mode, sheetCourse, state.selectedCourseId]);

  useEffect(() => {
    if (hydration === "course") {
      if (inbound.course === null) return void setHydration("view");
      if (!courses.data && !courses.isError) return;
      if (courses.data?.some((c) => c.id === inbound.course)) dispatch({ type: "select-course", id: inbound.course });
      setHydration("view");
    } else if (hydration === "view") {
      const course = state.selectedCourseId;
      const wantsVariant = inbound.variantKey !== null;
      if (course === null || (inbound.view === "course" && !wantsVariant) || inbound.view === "all") {
        if (inbound.view === "all") dispatch({ type: "view", view: "all" });
        return void setHydration("control");
      }
      // Class view checks the class against the course's; a variant (and All variations) the course's structure.
      if (inbound.view === "class" && !courseClasses.data && !courseClasses.isError) return;
      const needsStructure = wantsVariant || inbound.view === "all-variations";
      if (needsStructure && !detailStructure && !detail.isError) return;
      if (inbound.view === "class" && courseClasses.data?.some((c) => c.seq === inbound.classSeq)) dispatch({ type: "class", seq: inbound.classSeq });
      if (inbound.view === "all-variations" && variantKeys.length > 0) dispatch({ type: "view", view: "all-variations" });
      if (wantsVariant && variantKeys.includes(inbound.variantKey!)) dispatch({ type: "variant", key: inbound.variantKey });
      setHydration("control");
    } else if (hydration === "control") {
      if (inbound.control !== null) {
        if (!controlCoords.data && !controlCoords.isError) return;
        if (controlCoords.data?.some((c) => c.id === inbound.control)) dispatch({ type: "select", id: inbound.control });
      }
      // An opened sheet or template is checked by Layout itself.
      if (!layoutMode.settled) return;
      setHydration("done");
    }
  }, [hydration, inbound, courses.data, courses.isError, state.selectedCourseId, courseClasses.data, courseClasses.isError, detailStructure, detail.isError, variantKeys, controlCoords.data, controlCoords.isError, layoutMode.settled]);

  const urlState: EditorUrlState = {
    course: state.selectedCourseId,
    mode: state.mode,
    view: state.view,
    classSeq: state.classSeq,
    // Variant view's key; in Class view and Layout the drawn variant (omitted when it is the first, F8).
    variantKey: state.view === "variant" ? state.variantKey : state.variantKey !== null && sheetVariant === state.variantKey ? state.variantKey : null,
    layout: state.mode === "layout" ? layoutMode.shown : null,
  };
  const search = hydration === "done" ? editorSearchFor(urlState, searchParams, { phone: isMobile, firstVariant: variantKeys[0] ?? null }) : null;
  useEffect(() => {
    if (search !== null && search !== searchParams.toString()) setSearchParams(search, { replace: true });
  }, [search, searchParams, setSearchParams]);

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
      await utils.course.list.invalidate();
    },
  });
  const cutsEnabled = cutsQuery.data?.enabled !== false;

  // ─── Chrome ──────────────────────────────────────────────
  const canUndo = undoStack.canUndo, canRedo = undoStack.canRedo;
  // Materialised variants are edited through their root (course-layer.md §12): the picker lists roots and plain courses.
  const courseOptions = useMemo(() => (courses.data ?? []).filter((c) => c.parentCourseId == null).map((c) => ({ id: c.id, name: c.name })), [courses.data]);
  // The map-info dialog's values (§2, P6): the queries above and the loaded document's header.
  const mapInfoInput: MapInfoInput = {
    fileName: mapInfo.data?.fileName ?? null,
    uploadedAt: mapInfo.data?.uploadedAt ?? null,
    sizeBytes: mapInfo.data?.size ?? null,
    scale: mapInfo.data ? mapScale : null,
    meridianStalenessDeg: mapMetadata.data?.meridianStalenessDeg ?? null,
    documentHash,
    header: mapDoc?.header ?? null,
  };
  // The save state and the course-info values (§2, §3): the top bar's indicator and popover (no map scale since P6),
  // the phone's peek line (with it).
  const save: SaveState = pendingOps > 0 ? "saving" : notice ? "conflict" : errorMsg ? "error" : "saved";
  const status: StatusInput = {
    controls: selectedCourse ? sequenceIds.length : null,
    lengthM: selectedCourse ? courseChecks.lengthM ?? totalMeters : null,
    climbM: selectedCourse?.climb ?? null,
    scale: mapScale,
    sheetKey: state.mode === "layout" ? layoutMode.sheetKey : state.mode === "course" && state.view === "class" ? classView.sheetKey : null,
    snapping: state.snapping,
    checks: courseChecks.checks.length,
  };
  const toolbar = isMobile ? (
    <FieldTopBar
      backTo={`/${nameId ?? ""}/courses`}
      courses={courseOptions}
      selectedCourseId={state.selectedCourseId}
      onSelectCourse={(id) => dispatch({ type: "select-course", id })}
      mode={state.mode}
      onMode={(mode) => dispatch({ type: "mode", mode })}
      overflow={(
        <OverflowMenu
          view={state.view} onView={(view) => dispatch({ type: "view", view })}
          canUndo={canUndo} canRedo={canRedo} onUndo={runUndo} onRedo={runRedo}
          hideOthers={state.hideOthers} canHideOthers={state.selectedCourseId !== null} onToggleHideOthers={() => dispatch({ type: "toggle-hide-others" })}
          cutsEnabled={cutsEnabled} cutsBusy={setCuts.isPending || cutsQuery.isLoading} onToggleCuts={() => setCuts.mutate({ enabled: !cutsEnabled })}
          placementLoupe={placementLoupe} onTogglePlacementLoupe={togglePlacementLoupe}
        />
      )}
      presence={<PresenceChips compact others={presence} selectedCourseId={state.selectedCourseId} />}
    />
  ) : (
    <TopBar
      courses={courseOptions}
      selectedCourseId={state.selectedCourseId}
      onSelectCourse={(id) => dispatch({ type: "select-course", id })}
      view={state.view}
      onView={(view) => dispatch({ type: "view", view })}
      classes={selectedCourse ? (courseClasses.data ?? []) : []}
      classSeq={state.classSeq}
      onClass={(seq) => dispatch({ type: "class", seq })}
      variants={state.mode === "course" || state.mode === "layout" ? variantKeys : []}
      variantKey={state.view === "variant" ? state.variantKey : sheetVariant}
      onVariant={(key) => dispatch({ type: "variant", key })}
      allVariations={state.mode === "course"}
      exportState={{
        nameId: nameId ?? "",
        courseSeq: selectedCourse?.id ?? null,
        classSeq: state.view === "class" ? state.classSeq : null,
        sheetSeq: state.mode === "layout" ? layoutMode.sheetSeq : null,
        canEdit,
        variants: exportVariants,
        variantKey: state.view === "variant" ? state.variantKey : sheetVariant,
      }}
      onExportError={setErrorMsg}
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
      placementLoupe={placementLoupe}
      onTogglePlacementLoupe={togglePlacementLoupe}
      presence={<PresenceChips others={presence} selectedCourseId={state.selectedCourseId} />}
      save={save}
      status={status}
      map={mapInfoInput}
    />
  );

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
    kind: siteKindOf(selectedCoord.id),
    // §6.6: an item cannot become a crossing / map-issue point, a crossing point a leg runs through cannot change.
    onCourse: (membership.get(selectedCoord.id) ?? []).length > 0 || ends.start === selectedCoord.id || ends.finish === selectedCoord.id,
    routed: crossingRefs.has(selectedCoord.id),
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


  // ─── Field mode's parts (§9) ─────────────────────────────
  const selectedFieldPt: Pt | null = selectedCoord
    ? (nudged?.id === selectedCoord.id ? nudged.pt : { x: selectedCoord.mapX, y: selectedCoord.mapY })
    : null;
  const selectedFieldRow = selectedCoord
    ? fieldList.find((r) => r.id === selectedCoord.id)
      ?? fieldRows([{ id: selectedCoord.id, code: selectedCoord.code, kind: kindOf(selectedCoord.id), pt: selectedFieldPt }], paperFix, mapScale, checkedIds)[0]
    : null;
  const fieldSelection = fieldMode && selectedCoord && selectedFieldPt ? (
    <FieldSelection row={selectedFieldRow} pt={selectedFieldPt} mapScale={mapScale}
      onNudge={(to) => nudgeTo(selectedCoord.id, selectedFieldPt, to)}
      onCheck={fieldReadOnly ? null : (checked) => checkControl(selectedCoord.id, checked)}
      canCheck={canReview} canMove={!fieldReadOnly} />
  ) : null;
  const selectRow = (id: number) => {
    dispatch({ type: "select", id });
    const pt = ptOf(id);
    if (pt) centreOn(pt);
  };
  const fieldSection = (
    <>
      <div className="px-2.5 py-1"><FixStatus accuracyM={fix?.accuracy ?? null} error={geo.error} watching={geo.watching} /></div>
      <FieldSection rows={fieldList} selectedControlId={state.selectedControlId} onSelectRow={selectRow}
        onCheck={fieldReadOnly ? null : checkControl} canCheck={canReview} hasCourse={!!(selectedCourse && structure)} fix={paperFix} mapScale={mapScale} />
    </>
  );
  const fieldKpi = fieldMode && selectedCourse
    ? t("fieldKpiChecked", { checked: fieldList.filter((r) => r.kind === "control" && r.checked).length, count: fieldList.filter((r) => r.kind === "control").length })
    : null;

  // ─── Shared by both layouts ──────────────────────────────
  /* The course objects as DOM, for tests: what the editor holds (§7). */
  const objectsDom = (
    <ul data-testid="editor-objects" hidden>
      {objects.map((o) => (
        <li key={o.id} data-testid="editor-object-row" data-object-id={o.id} data-object-kind={o.kind}
          data-geometry={o.geometry.map((v) => `${v.x},${v.y}`).join(" ")} data-geometry-json={JSON.stringify(o.geometry)} data-props={JSON.stringify(o.props)} data-scope={JSON.stringify(o.scope)} />
      ))}
    </ul>
  );
  const courseSection = (
    <CourseSection
      course={selectedCourse && structure ? { id: selectedCourse.id, name: selectedCourse.name, orderMode: structure.orderMode } : null}
      rows={rows}
      legMeters={legMeters}
      totalMeters={totalMeters}
      suggestions={suggestionsForNew}
      onCreate={handleCreateCourse}
      onClone={handleClone}
      onOrderMode={(mode) => void applyStructure((s) => ({ ...s, orderMode: mode }))}
      onMove={(from, to) => void applyStructure((s) => moveVisit(s, from, to, kindOf, latest.current.orders))}
      onRemove={(seqIndex) => void applyStructure((s) => removeVisit(s, seqIndex, kindOf, latest.current.orders))}
      onEditCode={handleEditCode}
      onSelectRow={(id) => dispatch({ type: "select", id })}
      selectedControlId={state.selectedControlId}
      radioIds={radioIds}
      instructions={shownInstructions}
      onInstructions={handleInstructions}
      blocks={state.view === "all-variations" ? [] : blocks}
      variation={variationHandlers}
    />
  );
  const selectionSection = state.multi.length > 1 ? (
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
        const hull = tonerSaverGeometry(rows.flatMap((r) => (r.pt ? [r.pt] : [])), margin);
        if (hull) updateObject(selectedObject, { geometry: hull });
      } : undefined}
      onDelete={() => deleteObject(selectedObject)}
      filter={filterGroups && mapDoc ? {
        groups: filterGroups,
        swatchUrl: (g) => swatchUrl(g.swatch, mapDoc.hash, nameId ?? null),
        picking: state.tool.kind === "pick-symbol",
        onPickToggle: () => setTool(state.tool.kind === "pick-symbol" ? { kind: "select" } : { kind: "pick-symbol" }),
        note: pickNote?.objectId === selectedObject.id ? pickNote.note : null,
      } : undefined}
    />
  ) : selectedLeg ? (
    <LegSection
      title={`${selectedLeg.from.code} → ${selectedLeg.to.code}`}
      leg={selectedLeg.props}
      crossingCode={selectedLeg.props.crossing ? coordsById.get(selectedLeg.props.crossing.controlId)?.code ?? String(selectedLeg.props.crossing.controlId) : null}
      focusedBend={focusedBend}
      readOnly={!legEditable}
      onPatch={writeLeg}
      onFocusBend={focusBend}
      onBendKind={setBendCurve}
    />
  ) : (
    <>
      {fieldSelection}
      <SelectionSection
        selected={selectedInfo}
        onKind={(kind) => { if (selectedCoord) updateField(selectedCoord.id, { kind }, { kind: siteKindOf(selectedCoord.id) }); }}
        onNotes={(notes) => { if (selectedCoord) updateField(selectedCoord.id, { notes }, { notes: controlRowsById.get(selectedCoord.id)?.notes ?? "" }); }}
        onNumberHidden={(hidden) => { if (selectedCoord) { const id = selectedCoord.id; void applyStructure((s) => setNumberHidden(s, id, hidden)); } }}
      />
    </>
  );

  // Class view without a sheet for the class's course (docs/course-layout.md §6): the course draws as in Course view.
  const externalNode = external ? (
    <div data-testid="editor-external-change" className="pointer-events-auto w-64 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2 shadow-sm flex items-start gap-1.5">
      <p className="flex-1">
        {external.at
          ? t("externalChange", { who: external.who ?? t("presenceAnonymous"), time: clockTime(external.at, i18n.language) })
          : t("externalChangeUnknown")}
      </p>
      <button type="button" data-testid="editor-external-dismiss" className="px-1.5 rounded border border-amber-300 cursor-pointer" onClick={() => setExternal(null)}>{t("dismiss")}</button>
    </div>
  ) : null;
  const classNotice = state.mode === "course" && state.view === "class" && classView.missing ? (
    <div data-testid="editor-class-no-sheet" className="pointer-events-auto w-64 rounded-lg border border-slate-200 bg-white/95 text-slate-600 text-xs p-2 shadow-sm">
      {t("classNoSheet")}
    </div>
  ) : null;
  const noticeNode = notice ? (
    <div data-testid="editor-conflict" data-kind={notice.kind} className="pointer-events-auto w-64 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2 shadow-sm">
      {notice.kind === "refresh" ? (
        <p>{notice.items?.length ? t("conflictRefreshItems", { items: notice.items.join(", ") }) : t("conflictRefresh")}</p>
      ) : (
        <p>{notice.theirs
          ? notice.by
            ? t("conflictMovedBy", { who: notice.by.name || t("presenceAnonymous"), time: clockTime(notice.by.at, i18n.language), x: notice.theirs.x.toFixed(1), y: notice.theirs.y.toFixed(1) })
            : t("conflictMoved", { x: notice.theirs.x.toFixed(1), y: notice.theirs.y.toFixed(1) })
          : t("conflictRefresh")}</p>
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
  ) : null;

  /** The `+` menu (§10): an armed tool runs the pin-drop flow; the sheet drops to peek so the map shows. */
  const pickAdd = (c: AddChoice) => {
    setDetent("peek");
    if (c.kind === "place") armPlace(c.tool);
    else if (c.kind === "area") startArea(c.area);
    else setTool({ kind: "text" });
  };
  /** The sheet settled at a new height: past peek, the selected control is moved into the band above it. */
  const onSheetHeight = (px: number) => {
    setSheetPx(px);
    const pt = state.selectedControlId !== null ? ptOf(state.selectedControlId) : null;
    if (pt && detent !== "peek") centreOn(pt, px);
  };

  /** The phone (§10): full-bleed map, the bottom sheet (peek: KPIs, selection, action bar), the floating `+`. */
  const phoneOverlay = () => {
    const actions = (
      <div data-testid="editor-action-bar" className="flex gap-1 overflow-x-auto -mx-1 px-1">
        {contextActions.map((a) => (
          <button key={a.id} type="button" data-testid={`editor-action-${a.id}`} title={a.title} onClick={a.onClick} disabled={a.disabled}
            className={`shrink-0 min-h-11 px-3 rounded-lg border text-sm whitespace-nowrap cursor-pointer disabled:opacity-40 ${a.variant === "danger" ? "border-red-200 text-red-600" : "border-slate-200 text-slate-700"}`}>
            {a.label}
          </button>
        ))}
      </div>
    );
    const selectionName = selectedCoord
      ? `${selectedCoord.code}${selectedInfo?.description ? ` · ${selectedInfo.description}` : ""}`
      : selectedObject ? t(`kind_${selectedObject.kind}`) : null;
    const peek = (
      <div className="flex flex-col gap-1.5 pb-2">
        <div className="flex items-center gap-2 min-w-0 text-xs">
          <StatusBar status={status} save={save} />
          {fieldKpi && <span data-testid="editor-field-kpi" className="shrink-0 text-emerald-700">{fieldKpi}</span>}
        </div>
        {selectionName && <div data-testid="editor-sheet-selection" className="truncate text-slate-700 font-medium">{selectionName}</div>}
        {!toolActive && (contextActions.length > 0 || suggestions.length > 0) && actions}
      </div>
    );
    return (
      <div className="relative w-full h-full">
        {objectsDom}
        <div className="absolute top-2 inset-x-2 z-30 flex flex-col gap-1.5 pointer-events-none">
          {noticeNode}
          {externalNode}
          {fieldReadOnly && <OfflineNotice />}
          {errorMsg && <span data-testid="editor-error" className="pointer-events-auto w-fit text-[11px] text-red-600 bg-white/95 rounded px-1.5">{errorMsg}</span>}
          {showExhausted && <span data-testid="series-exhausted" className="pointer-events-auto w-fit text-[11px] text-amber-700 bg-white/95 rounded px-1.5">{tc("seriesExhausted")}</span>}
        </div>
        {!toolActive && (
          <AddMenu bottomPx={sheetPx} disabled={fieldReadOnly} canTonerSaver={canTonerSaver} onPick={pickAdd} />
        )}
        <BottomSheet detent={detent} onDetent={setDetent} onHeight={onSheetHeight} peek={peek} label={t("sheet")}>
          {suggestions.length > 0 && !toolActive && (
            <div className="px-2.5 py-1 flex flex-col gap-1">
              {suggestions.map((sg) => (
                <button key={sg.id} type="button" data-testid={`editor-suggestion-${sg.id}`} onClick={sg.onApply}
                  className="min-h-11 px-3 rounded-lg border border-purple-200 text-left text-sm text-purple-700 cursor-pointer">{sg.label}</button>
              ))}
            </div>
          )}
          <div data-testid="editor-inspector-selection">{selectionSection}</div>
          <div className="border-t border-slate-100 mt-1 pt-1" data-testid={fieldMode ? "editor-inspector-field" : "editor-inspector-course"}>
            {fieldMode ? fieldSection : courseSection}
          </div>
          <ChecksSection checks={courseChecks.checks} onLocate={locateCheck} />
        </BottomSheet>
      </div>
    );
  };

  const overlay = isMobile ? phoneOverlay() : (
    <div className="flex gap-2 h-full min-h-0 items-stretch">
      {objectsDom}
      {/* Field mode has no tool rail: it plans nothing new from the desk (§9); the keys still arm the tools. */}
      {state.mode === "layout" ? layoutMode.rail : !fieldMode && <ToolRail
        tool={state.tool}
        onTool={(key) => {
          if (key === "V") exitTool();
          else if (key === "S" || key === "K" || key === "M") armPlace(key === "S" ? "start" : key === "M" ? "finish" : "control");
          else if (key === "C") armPlace("crossing");
          else if (key === "X") armPlace("exchange");
          else if (key === "T") setTool({ kind: "text" });
          else if (key === "G") setTool({ kind: "gap", legInsertAt: state.selectedControlId === null ? state.phantom?.insertAt ?? null : null });
        }}
        onArea={startArea}
        areaOpen={areaOpen}
        onAreaOpen={setAreaOpen}
        canGap={canGap}
        canTonerSaver={canTonerSaver}
        canCorridor={canCorridor}
        onCorridor={addCorridor}
        snapping={state.snapping}
        onSnapping={() => dispatch({ type: "toggle-snapping" })}
      />}
      <div className="flex flex-col gap-2 min-h-0 h-full">
        {fieldReadOnly && <div className="w-64"><OfflineNotice /></div>}
        {noticeNode}
        {externalNode}
        {classNotice}
        <Inspector>
          {state.mode === "layout" ? layoutMode.inspector : <>
          {fieldMode ? (
            <InspectorSection title={t("fieldControls")} testId="editor-inspector-field" aside={selectedCourse?.name}>{fieldSection}</InspectorSection>
          ) : (
            <InspectorSection title={t("sequence")} testId="editor-inspector-course" aside={selectedCourse?.name}>{courseSection}</InspectorSection>
          )}
          <InspectorSection title={t("selection")} testId="editor-inspector-selection">{selectionSection}</InspectorSection>
          <InventorySection inventory={inventory} activeSeriesId={activeSeriesId} onSeries={setAllocSeriesId} />
          <ChecksSection checks={courseChecks.checks} onLocate={locateCheck} />
          </>}
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
        </div>
      </div>
    </div>
  );

  return (
    // A phone gets the whole screen (§10: full-bleed canvas, the compact top bar's back leaves the editor).
    // The desktop takes the window less the shell's chrome (§2, F28): the header's 99 px (the 56 px row,
    // the 42 px tabs row, the header's 1 px border) and the container's `py-3` (1.5rem).
    <div data-testid="editor-page" data-mode={state.mode} data-layout={isMobile ? "phone" : "desktop"}
      className={isMobile ? "fixed inset-0 z-[60] bg-white" : "h-[calc(100dvh-99px-1.5rem)] min-h-[420px]"}>
      <div className={isMobile ? "h-full overflow-hidden" : "h-full bg-white rounded-xl border border-slate-200 overflow-hidden"}>
        <MapPanel
          fillContainer
          fitToControls
          filterMode={(state.mode === "layout" ? layoutMode.courseOnly : state.hideOthers || (state.view === "class" && !!classLayout)) && selectedCourse && courseView ? "course" : "all"}
          defaultShowDescriptions={!isMobile}
          descriptionsAllControls
          toolbar={toolbar}
          mapOverlay={overlay}
          mapOverlayLayout={isMobile ? "fill" : "corner"}
          fullscreenOverlay={descControl ? (
            <ControlDescriptionEditor controlCode={descControl.code} initial={descControl.description} onSave={saveDescription} onCancel={closeDescription} />
          ) : null}
          editor={state.mode === "layout" ? layoutEditor : editor}
          highlightCourseName={highlightCourseName}
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

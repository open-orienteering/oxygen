/**
 * Layout mode (docs/course-layout.md §2–4; research 08 §4.6, §5.3, §5.4;
 * 05 §5.12): the sheet as the view. The page is drawn on the GL canvas
 * through the composer's own input (`courseMap.resolveSheet` → the course
 * layer with the sheet's layout objects, the page part over it, the map
 * clipped to the frame), the paper, margin and frame on the UI layer.
 *
 * - Scope: a sheet (`?sheet=`, or the selected course's first sheet; the
 *   class's first sheet in Class view, docs/course-layout.md §6; the
 *   all-controls sheet in view All; a setter sheet opened from the *Setter
 *   maps* section, F10) edits its own objects, block, print
 *   scale and window centre — the template's objects are drawn locked,
 *   with a link to the template; a template (`?template=`) edits the
 *   template, previewed with the selected course.
 * - One gesture, one write, one undo entry (docs/course-editor.md §3):
 *   `courseMap.saveLayout` in sheet scope, `mapTemplate.update` in
 *   template scope — whole snapshots sent with the row's version token;
 *   a stale one is the refresh notice (docs/course-layout.md §2).
 * - Course edits are locked: the binding is exclusive and the keys are
 *   Layout's own.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validateCourseMap, type CourseMapDocument, type CourseMapObject } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import { VersionBook, versionConflictOfError } from "../../../lib/version-book";
import { EditorConflict } from "../../../lib/editor/write-client";
import type { MapViewerEditorProps, ToolPointer } from "../../../components/MapViewer";
import { descriptionRect, gridSnap, pageBounds, pathFromView, pathRule, type SheetGeometry } from "../../../lib/editor/layout";
import { deleteVertex, type Vertex } from "../../../lib/editor/geometry-edit";
import type { Gesture } from "../tools/bindings";
import { step as polygonStep } from "../tools/polygon";
import { constrainDescription } from "../../../lib/map-layout-editor";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import type { EditorView } from "../../../lib/editor/state";
import { LAYOUT_KEYS, layoutBinding, type LayoutChange, type LayoutGesture, type LayoutSelection, type LayoutTarget, type LayoutTool, type PlaceKind } from "../layout/bindings";
import { LayoutInspector } from "../layout/LayoutInspector";
import { LayoutRail } from "../layout/LayoutRail";
import { ClassOverridesSection, ClubTemplatesSection, TemplateKeySection } from "../layout/KeySections";
import { NoSheetActions, SheetActions, TemplateActions } from "../layout/SheetActions";
import { SetterSection } from "../layout/SetterSection";
import { useCapabilities } from "../../../context/CapabilitiesContext";
import { geometryOf, layoutRequestOf, pathObject, placeObject, scopeObjects, sheetKeyOf, snapshotOf, templateWriteOf, withEditable, type EditorSheet, type LayoutSnapshot } from "../layout/model";

type Pt = { x: number; y: number };

export interface LayoutModeArgs {
  enabled: boolean;
  nameId: string;
  /** The top bar's course (its seq): the sheet's course, or the template's preview course. */
  course: { id: number; name: string } | null;
  view: EditorView;
  /** Class view's class (seq): its own sheet is the default target. */
  classSeq: number | null;
  /** A root's variant the sheet is drawn as (F8; `courseMap.resolveSheet { variantKey }`); null otherwise. */
  variantKey?: string | null;
  /** One write, through the page's pending count and error line; `undefined` when it failed. */
  run: <T>(op: () => Promise<T>) => Promise<T | undefined>;
  record: (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;
}

export interface LayoutMode {
  /** The viewer props Layout mode replaces Course mode's with. */
  editor: MapViewerEditorProps;
  rail: ReactNode;
  inspector: ReactNode;
  /** The sheet's course only, as it prints (a course sheet); every control on the all-controls sheet. */
  courseOnly: boolean;
  /** Layout's keys; true when handled. */
  onKey: (e: KeyboardEvent) => boolean;
  /** Open a sheet or a template (deep links, the inspector's template link). */
  open: (target: LayoutTarget | null) => void;
  /** The shown sheet's course (its seq), null for the all-controls sheet and a template. */
  sheetCourse: number | null;
  /** The sheet key of the top bar's course-info popover (§2; P2). */
  sheetKey: string | null;
  /** The shown sheet (its seq) for Export ▾ "This sheet"; null on a template or without a sheet. */
  sheetSeq: number | null;
  /** What Layout shows, for the URL's `sheet=` / `template=` (F31); null until it has loaded or with nothing to show. */
  shown: LayoutTarget | null;
  /** False while an opened sheet or template is still being checked against the event's (F31). */
  settled: boolean;
}

interface WriteTarget { key: string; scope: "sheet" | "template"; sheetSeq: number | null; templateSeq: number }

export function useLayoutMode(a: LayoutModeArgs): LayoutMode {
  const utils = trpc.useUtils();
  const client = utils.client;
  const coarse = useMediaQuery("(pointer: coarse)");
  const canEdit = useCapabilities().has("courses.edit");
  const [target, setTarget] = useState<LayoutTarget | null>(null);

  const sheets = trpc.courseMap.list.useQuery(undefined, { enabled: a.enabled });
  // F31: an opened sheet or template that is not this event's gives way to the default (and leaves the URL).
  const templates = trpc.mapTemplate.list.useQuery(undefined, { enabled: a.enabled && !!target && "template" in target });
  const targetKnown = !target ? true
    : "sheet" in target ? (sheets.data ? sheets.data.some((r) => r.seq === target.sheet) : null)
    : (templates.data ? templates.data.some((r) => r.seq === target.template) : null);
  useEffect(() => { if (targetKnown === false) setTarget(null); }, [targetKnown]);
  const resolvedTarget = useMemo((): LayoutTarget | null => {
    const rows = sheets.data ?? [];
    // An opened course sheet gives way when the top bar picks another course or view All.
    const opened = target && "sheet" in target ? rows.find((r) => r.seq === target.sheet) : undefined;
    const stale = !!opened && opened.kind === "course" && (a.view === "all" || (!!a.course && opened.courseId !== a.course.id));
    if (target && !stale) return target;
    if (a.view === "all") {
      const all = rows.find((r) => r.kind === "all_controls" && r.templateId !== null);
      return all ? { sheet: all.seq } : null;
    }
    if (!a.course) return null;
    const byOrder = (x: { sortOrder: number; seq: number }, y: { sortOrder: number; seq: number }) => x.sortOrder - y.sortOrder || x.seq - y.seq;
    // Class view: the class's own sheet (docs/course-layout.md §6); a class without one shows its course's.
    const classSheet = a.view === "class" && a.classSeq !== null
      ? rows.filter((r) => r.class?.seq === a.classSeq && r.templateId !== null).sort(byOrder)[0]
      : undefined;
    if (classSheet) return { sheet: classSheet.seq };
    const first = rows
      .filter((r) => r.kind === "course" && r.courseId === a.course!.id && r.class === null && r.templateId !== null)
      .sort(byOrder)[0];
    return first ? { sheet: first.seq } : null;
  }, [target, sheets.data, a.view, a.course, a.classSeq]);
  // An opened target is resolved only once it is known to be the event's (F31: no request for a stale link's sheet).
  const input = resolvedTarget && targetKnown === true
    ? "sheet" in resolvedTarget
      ? { seq: resolvedTarget.sheet, ...(a.variantKey ? { variantKey: a.variantKey } : {}) }
      : { templateSeq: resolvedTarget.template, ...(a.course ? { courseSeq: a.course.id } : {}) }
    : null;
  const key = input ? JSON.stringify(input) : "";
  const query = trpc.courseMap.resolveSheet.useQuery(input ?? { seq: 1 }, { enabled: a.enabled && !!input });
  const data: EditorSheet | null = input && query.data ? query.data : null;

  // ─── The snapshot: stored, the last write until the refetch has it, a drag's preview ──
  const [local, setLocal] = useState<{ key: string; snap: LayoutSnapshot; at: number } | null>(null);
  const [draft, setDraft] = useState<LayoutSnapshot | null>(null);
  const base = useMemo(() => (data ? snapshotOf(data) : null), [data]);
  const stored = local && local.key === key && query.dataUpdatedAt <= local.at ? local.snap : base;
  const snap = draft ?? stored;
  const geometry: SheetGeometry | null = useMemo(() => (data && snap ? geometryOf(data, snap) : null), [data, snap]);
  const scoped = useMemo(() => (data && snap ? scopeObjects(data, snap) : { editable: [], locked: [] }), [data, snap]);

  const [selection, setSelection] = useState<LayoutSelection>(null);
  /** The selected path's focused vertex (a click on its handle), keyed by the object so a selection change drops it. */
  const [focus, setFocus] = useState<{ id: string; index: number } | null>(null);
  const [tool, setTool] = useState<LayoutTool>({ kind: "select" });
  const [snapping, setSnapping] = useState(false);
  const gesture = useRef<LayoutGesture>(null);
  /** `P`'s drawing (the course editor's area flow): its gesture and hover, paper mm. */
  const drawGesture = useRef<Gesture>(null);
  const [drawHover, setDrawHover] = useState<Pt | null>(null);
  const [viewRequest, setViewRequest] = useState<MapViewerEditorProps["viewRequest"]>(null);
  useEffect(() => { setSelection(null); setTool({ kind: "select" }); setDraft(null); }, [key]);

  const fit = useCallback(() => {
    if (geometry) setViewRequest((v) => ({ key: (v?.key ?? 0) + 1, bounds: pageBounds(geometry) }));
  }, [geometry]);
  // A new sheet opens fitted, upright.
  const fitted = useRef("");
  useEffect(() => {
    if (!a.enabled) { fitted.current = ""; return; }
    if (geometry && fitted.current !== key) { fitted.current = key; fit(); }
  }, [a.enabled, geometry, key, fit]);

  // ─── Writes ──────────────────────────────────────────────
  // The newest token seen per sheet / template (docs/course-layout.md §2): reads and write results raise it.
  const [versions] = useState(() => new VersionBook());
  useEffect(() => {
    if (!data) return;
    if (data.sheet) versions.seed("sheet", data.sheet.seq, data.sheet.version);
    versions.seed("template", data.template.seq, data.template.version);
  }, [data, versions]);
  const writeTarget: WriteTarget | null = data
    ? { key, scope: data.scope, sheetSeq: data.sheet?.seq ?? null, templateSeq: data.template.seq }
    : null;
  const save = useCallback(async (w: WriteTarget, s: LayoutSnapshot) => {
    const kind = w.scope === "sheet" && w.sheetSeq !== null ? "sheet" : "template";
    const id = kind === "sheet" ? w.sheetSeq! : w.templateSeq;
    try {
      if (kind === "sheet") {
        const r = await client.courseMap.saveLayout.mutate({
          // The template's objects are locked here and not written: a sheet gesture never touches the template.
          id, windowCenter: s.centre, printScale: s.printScale, description: s.description, objects: s.sheetObjects,
          baseVersion: versions.get("sheet", id),
        });
        versions.seed("sheet", id, r.version);
      } else {
        const r = await client.mapTemplate.update.mutate({ id, ...templateWriteOf(s), baseVersion: versions.get("template", id) });
        versions.seed("template", id, r.version);
      }
    } catch (e) {
      // Another setter wrote the sheet or template: refresh and redo (no merge of whole snapshots).
      const conflict = versionConflictOfError(e);
      if (!conflict) throw e;
      versions.seed(kind, id, conflict.version);
      void utils.courseMap.resolveSheet.invalidate();
      throw new EditorConflict({ kind: "refresh", differing: null }, kind, id);
    }
    setLocal({ key: w.key, snap: s, at: Date.now() });
    void utils.courseMap.resolveSheet.invalidate();
    void utils.courseMap.list.invalidate();
    void utils.mapTemplate.list.invalidate();
    return true;
  }, [client, utils, versions]);

  const { run, record } = a;
  /** One gesture: the whole snapshot written, one undo entry writing back the one it replaced. */
  const commit = useCallback(async (next: LayoutSnapshot) => {
    if (!writeTarget || !stored) return;
    const prev = stored, w = writeTarget;
    setLocal({ key: w.key, snap: next, at: Number.POSITIVE_INFINITY });
    const redo = () => save(w, next);
    if ((await run(redo)) === undefined) { setLocal(null); return; }
    record(() => save(w, prev), redo);
  }, [writeTarget, stored, save, run, record]);

  const apply = useCallback((s: LayoutSnapshot, c: LayoutChange): LayoutSnapshot => {
    let next = s;
    if (c.centre) next = { ...next, centre: c.centre };
    if (c.description) next = { ...next, description: c.description };
    if (c.objects && data) next = withEditable(data, next, c.objects);
    return next;
  }, [data]);
  const change = useCallback((c: LayoutChange) => { if (stored) void commit(apply(stored, c)); }, [stored, commit, apply]);
  const patchSnapshot = useCallback((p: Partial<LayoutSnapshot>) => { if (stored) void commit({ ...stored, ...p }); }, [stored, commit]);

  const block = useMemo(
    () => (data && snap?.description.visible ? descriptionRect(snap.description, data.descriptionRowCount, data.descriptionHeaderRows) : null),
    [data, snap],
  );
  const purple = snap?.settings.appearance.purple ?? "#a626ff";
  const place = useCallback((what: Exclude<PlaceKind, "path">, at: Pt, graphicId?: number) => {
    if (!stored || !geometry || !data) return;
    const page = gridSnap(at, snapping);
    setTool({ kind: "select" });
    if (what === "description") {
      const size = descriptionRect({ ...stored.description, x: page.x, y: page.y }, data.descriptionRowCount, data.descriptionHeaderRows);
      change({ description: constrainDescription({ ...stored.description, visible: true, x: page.x, y: page.y }, size.width, size.height, geometry.printable) });
      setSelection({ kind: "description" });
      return;
    }
    const o = placeObject(what, page, geometry.printable, graphicId);
    if (!o) return;
    change({ objects: [...scopeObjects(data, stored).editable, o] });
    setSelection({ kind: "object", id: o.id });
  }, [stored, geometry, data, change, snapping]);
  /** `P` closed: one closed page path, one write, selected (docs/course-layout.md §3). */
  const finishPath = useCallback((points: Vertex[]) => {
    setTool({ kind: "select" });
    if (!stored || !geometry || !data) return;
    const o = pathObject(points, geometry.printable);
    change({ objects: [...scopeObjects(data, stored).editable, o] });
    setSelection({ kind: "object", id: o.id });
  }, [stored, geometry, data, change]);

  const selectedPath = selection?.kind === "object" ? scoped.editable.find((o) => o.id === selection.id && o.kind === "path") : undefined;
  // Undo / redo may leave the index past the end: no focus then.
  const focusedVertex = focus && selectedPath?.kind === "path" && focus.id === selectedPath.id && focus.index < selectedPath.points.length ? focus.index : null;
  const onVertexFocus = useCallback((index: number | null) => {
    setFocus(index === null || selection?.kind !== "object" ? null : { id: selection.id, index });
  }, [selection]);

  const binding = useMemo(() => {
    if (!a.enabled || !geometry || !snap) return null;
    return layoutBinding({
      geometry, editable: scoped.editable, locked: scoped.locked, description: snap.description, block, centre: snap.centre,
      // Align map stores a sheet's window; a template has none (its preview follows the course).
      selection: data?.scope === "template" && selection?.kind === "frame" ? null : selection,
      tool, snapping, gesture,
      imageHref: (id) => `/api/maps/${encodeURIComponent(a.nameId)}/graphics/${id}`,
      onPreview: (c) => setDraft(c && stored ? apply(stored, c) : null),
      onCommit: change,
      onSelect: setSelection,
      onPlace: place,
      focusedVertex, onVertexFocus,
      draw: tool.kind === "draw" ? {
        gesture: drawGesture, hover: drawHover,
        onHover: (p: ToolPointer | null) => setDrawHover(p?.pt ?? null),
        onPoly: (poly) => setTool({ kind: "draw", poly }),
        onPath: finishPath,
        onCancel: () => setTool({ kind: "select" }),
      } : undefined,
    });
  }, [a.enabled, a.nameId, geometry, snap, scoped, block, data?.scope, selection, tool, snapping, stored, apply, change, place, drawHover, finishPath, focusedVertex, onVertexFocus]);

  const layoutRequest = useMemo(() => (a.enabled && data && snap && geometry ? layoutRequestOf(data, snap, geometry) : null), [a.enabled, data, snap, geometry]);

  // ─── Selection helpers, keys ─────────────────────────────
  const selectedObject = selection?.kind === "object" ? scoped.editable.find((o) => o.id === selection.id) ?? null : null;
  const updateObject = useCallback((id: string, patch: Partial<CourseMapObject>) => {
    if (!data || !stored) return;
    change({ objects: scopeObjects(data, stored).editable.map((o) => (o.id === id ? ({ ...o, ...patch } as CourseMapObject) : o)) });
  }, [data, stored, change]);
  const deleteSelected = useCallback(() => {
    if (!data || !stored) return;
    if (selection?.kind === "object") change({ objects: scopeObjects(data, stored).editable.filter((o) => o.id !== selection.id) });
    else if (selection?.kind === "description") change({ description: { ...stored.description, visible: false } });
    setSelection(null);
  }, [data, stored, selection, change]);

  const onTool = useCallback((what: PlaceKind | "select", graphicId?: number) => {
    if (what === "select") { setTool({ kind: "select" }); return; }
    if (what === "description" && snap?.description.visible) { setTool({ kind: "select" }); setSelection({ kind: "description" }); return; }
    if (what === "image" && graphicId === undefined) return;
    if (what === "path") {
      // A fresh drawing: no gesture or hover left from an earlier one.
      drawGesture.current = null;
      setDrawHover(null);
      setTool({ kind: "draw", poly: { kind: "layout_path", vertices: [] } });
      return;
    }
    setTool({ kind: "place", what, ...(graphicId !== undefined ? { graphicId } : {}) });
  }, [snap]);

  const onKey = useCallback((e: KeyboardEvent): boolean => {
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === "Escape") {
      if (tool.kind !== "select") { setTool({ kind: "select" }); return true; }
      if (selection) { setSelection(null); return true; }
      return false;
    }
    if (e.key === "Enter" && plain && tool.kind === "draw") {
      // Through the flow, as Course mode's areas: the minimum and the smooth vertices' settling have one home.
      e.preventDefault();
      const r = polygonStep(tool.poly, { type: "enter" });
      if (r.done && geometry) finishPath(pathFromView(r.done, geometry, geometry.printable));
      return true;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // A focused vertex goes first, down to the path's minimum; there nothing happens (course-editor.md §7).
      if (selectedPath?.kind === "path" && focusedVertex !== null) {
        const points = deleteVertex(selectedPath.points, focusedVertex, pathRule(selectedPath).min);
        if (points) { updateObject(selectedPath.id, { points }); setFocus(null); }
        return true;
      }
      deleteSelected();
      return true;
    }
    if (e.key === "Tab" && plain) {
      e.preventDefault();
      const list = scoped.editable;
      if (list.length === 0) return true;
      const at = selection?.kind === "object" ? list.findIndex((o) => o.id === selection.id) : -1;
      const n = list.length, next = list[at < 0 ? (e.shiftKey ? n - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + n) % n];
      setSelection({ kind: "object", id: next.id });
      return true;
    }
    if (!plain) return false;
    if (key === "F") { fit(); return true; }
    const what = LAYOUT_KEYS[key];
    if (what) {
      // `I` arms the image tool only with a graphic picked in the Graphics section.
      if (what === "image") return true;
      onTool(what);
      return true;
    }
    return false;
  }, [tool, selection, deleteSelected, scoped, fit, onTool, geometry, finishPath, selectedPath, focusedVertex, updateObject]);

  // ─── Validation (validate.ts, unchanged codes) ───────────
  const issues = useMemo(() => {
    if (!data || !snap || !geometry) return [];
    const document: CourseMapDocument = {
      ...data.document,
      paper: snap.paper as CourseMapDocument["paper"], orientation: snap.orientation as CourseMapDocument["orientation"], printScale: snap.printScale,
      printMarginMm: snap.settings.printMarginMm, mapFrame: geometry.frame, description: snap.description, appearance: snap.settings.appearance,
      objects: [...snap.templateObjects, ...snap.sheetObjects],
    };
    return validateCourseMap({
      document, mapScale: data.mapScale, window: geometry.window, windows: [geometry.window, ...data.windows.slice(1)],
      variants: [{ key: "", controls: data.controls }], descriptionRowCount: data.descriptionRowCount, descriptionHeaderRows: data.descriptionHeaderRows,
    }).issues;
  }, [data, snap, geometry]);

  const editor: MapViewerEditorProps = useMemo(() => ({
    actionLayout: "bar",
    contextActions: [],
    tool: binding,
    layout: layoutRequest,
    viewRequest,
    onDismiss: () => setSelection(null),
  }), [binding, layoutRequest, viewRequest]);

  const open = useCallback((next: LayoutTarget | null) => setTarget(next), []);

  const rail = <LayoutRail tool={tool} onTool={(w) => onTool(w)} canImage={false} snapping={snapping} onSnapping={() => setSnapping((v) => !v)} />;

  const siblings = (sheets.data ?? []).filter((r) => (data?.sheet ? r.courseId === data.sheet.courseSeq && r.kind === data.sheet.kind && (r.class?.seq ?? null) === data.sheet.classSeq : false));

  // The sections keep their height (the inspector scrolls) instead of squeezing into each other.
  const inspector = (
    <div className="shrink-0 flex flex-col">
    <LayoutInspector
      loading={a.enabled && (sheets.isLoading || (!!input && query.isLoading))}
      data={data}
      snap={snap}
      geometry={geometry}
      courseName={a.course?.name ?? null}
      sheets={siblings}
      selection={selection}
      selectedObject={selectedObject}
      editable={scoped.editable}
      lockedCount={scoped.locked.length}
      issues={issues}
      coarse={coarse}
      tool={tool}
      purple={purple}
      onOpen={open}
      onSelect={setSelection}
      onPatch={patchSnapshot}
      onObject={updateObject}
      onDelete={deleteSelected}
      onPlaceImage={(id) => onTool("image", id)}
      canEdit={canEdit}
      templateActions={data ? <TemplateActions template={data.template} canEdit={canEdit} run={run} onOpen={open} /> : null}
      noSheet={<NoSheetActions view={a.view} course={a.course} canEdit={canEdit} run={run} onOpen={open} />}
      sheetActions={data?.sheet ? (
        <SheetActions sheet={data.sheet} templateSeq={data.template.seq} siblings={siblings} courseName={a.course?.name ?? null}
          canEdit={canEdit} versions={versions} run={run} record={record} onOpen={open} />
      ) : null}
    />
    {data && (
      <TemplateKeySection template={data.template} sheets={sheets.data ?? []} canEdit={canEdit} run={run} record={record} onOpen={open}
        sheetCourse={data.sheet?.kind === "course" && data.sheet.classSeq === null ? data.sheet.courseSeq : null} />
    )}
    {data?.sheet?.kind === "course" && data.sheet.courseSeq !== null && (
      <ClassOverridesSection courseSeq={data.sheet.courseSeq} canEdit={canEdit} run={run} record={record} onOpen={open} />
    )}
    <SetterSection view={a.view} course={a.course} rows={sheets.data ?? []} openSheet={data?.sheet?.seq ?? null}
      canEdit={canEdit} versions={versions} run={run} record={record} onOpen={open} />
    {data && <ClubTemplatesSection template={data.template} canEdit={canEdit} run={run} onOpen={open} />}
    </div>
  );

  return { editor, rail, inspector, courseOnly: data?.sheet?.kind === "course", onKey, open, sheetCourse: data?.sheet?.courseSeq ?? null, sheetKey: snap ? sheetKeyOf(snap) : null, sheetSeq: data?.sheet?.seq ?? null,
    shown: data ? (data.scope === "sheet" && data.sheet ? { sheet: data.sheet.seq } : { template: data.template.seq }) : null,
    settled: !a.enabled || targetKnown === true && (!input || !!query.data || query.isError) };
}

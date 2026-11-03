/**
 * Layout mode (docs/course-layout.md §2–4; research 08 §4.6, §5.3, §5.4;
 * 05 §5.12): the sheet as the view. The page is drawn on the GL canvas
 * through the composer's own input (`courseMap.resolveSheet` → the course
 * layer with the sheet's layout objects, the page part over it, the map
 * clipped to the frame), the paper, margin and frame on the UI layer.
 *
 * - Scope: a sheet (`?sheet=`, or the selected course's first sheet; the
 *   all-controls sheet in view All) edits its own objects, block, print
 *   scale and window centre — the template's objects are drawn locked,
 *   with a link to the template; a template (`?template=`) edits the
 *   template, previewed with the selected course.
 * - One gesture, one write, one undo entry (docs/course-editor.md §3):
 *   `courseMap.saveLayout` in sheet scope, `mapTemplate.update` in
 *   template scope — whole snapshots, last writer wins (no version token
 *   on sheets and templates, docs/course-layout.md §2).
 * - Course edits are locked: the binding is exclusive and the keys are
 *   Layout's own.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validateCourseMap, type CourseMapDocument, type CourseMapObject } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import type { MapViewerEditorProps } from "../../../components/MapViewer";
import { descriptionRect, pageBounds, type SheetGeometry } from "../../../lib/editor/layout";
import { constrainDescription } from "../../../lib/map-layout-editor";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import type { EditorView } from "../../../lib/editor/state";
import { LAYOUT_KEYS, layoutBinding, type LayoutChange, type LayoutGesture, type LayoutSelection, type LayoutTarget, type LayoutTool, type PlaceKind } from "../layout/bindings";
import { LayoutInspector } from "../layout/LayoutInspector";
import { LayoutRail } from "../layout/LayoutRail";
import { geometryOf, layoutRequestOf, placeObject, scopeObjects, snapshotOf, withEditable, type EditorSheet, type LayoutSnapshot } from "../layout/model";

type Pt = { x: number; y: number };

export interface LayoutModeArgs {
  enabled: boolean;
  nameId: string;
  /** The top bar's course (its seq): the sheet's course, or the template's preview course. */
  course: { id: number; name: string } | null;
  view: EditorView;
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
}

interface WriteTarget { key: string; scope: "sheet" | "template"; sheetSeq: number | null; templateSeq: number }

export function useLayoutMode(a: LayoutModeArgs): LayoutMode {
  const utils = trpc.useUtils();
  const client = utils.client;
  const coarse = useMediaQuery("(pointer: coarse)");
  const [target, setTarget] = useState<LayoutTarget | null>(null);

  const sheets = trpc.courseMap.list.useQuery(undefined, { enabled: a.enabled });
  const resolvedTarget = useMemo((): LayoutTarget | null => {
    const rows = sheets.data ?? [];
    // An opened course sheet gives way when the top bar picks another course.
    const opened = target && "sheet" in target ? rows.find((r) => r.seq === target.sheet) : undefined;
    const stale = !!opened && opened.kind === "course" && a.view === "course" && !!a.course && opened.courseId !== a.course.id;
    if (target && !stale) return target;
    if (a.view === "all") {
      const all = rows.find((r) => r.kind === "all_controls" && r.templateId !== null);
      return all ? { sheet: all.seq } : null;
    }
    if (!a.course) return null;
    const first = rows
      .filter((r) => r.kind === "course" && r.courseId === a.course!.id && r.templateId !== null)
      .sort((x, y) => x.sortOrder - y.sortOrder || x.seq - y.seq)[0];
    return first ? { sheet: first.seq } : null;
  }, [target, sheets.data, a.view, a.course]);
  const input = resolvedTarget
    ? "sheet" in resolvedTarget ? { seq: resolvedTarget.sheet } : { templateSeq: resolvedTarget.template, ...(a.course ? { courseSeq: a.course.id } : {}) }
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
  const [tool, setTool] = useState<LayoutTool>({ kind: "select" });
  const [snapping, setSnapping] = useState(false);
  const gesture = useRef<LayoutGesture>(null);
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
  const writeTarget: WriteTarget | null = data
    ? { key, scope: data.scope, sheetSeq: data.sheet?.seq ?? null, templateSeq: data.template.seq }
    : null;
  const save = useCallback(async (w: WriteTarget, s: LayoutSnapshot) => {
    if (w.scope === "sheet" && w.sheetSeq !== null) {
      await client.courseMap.saveLayout.mutate({
        id: w.sheetSeq, windowCenter: s.centre, printScale: s.printScale, description: s.description, objects: s.sheetObjects, templateObjects: s.templateObjects,
      });
    } else {
      await client.mapTemplate.update.mutate({
        id: w.templateSeq, paper: s.paper as "A4", orientation: s.orientation as "portrait",
        ...(s.paper === "custom" ? { paperWidthMm: s.paperWidthMm, paperHeightMm: s.paperHeightMm } : {}),
        printScale: s.printScale, settings: { ...s.settings, description: s.description }, objects: s.templateObjects,
      });
    }
    setLocal({ key: w.key, snap: s, at: Date.now() });
    void utils.courseMap.resolveSheet.invalidate();
    void utils.courseMap.list.invalidate();
    void utils.mapTemplate.list.invalidate();
    return true;
  }, [client, utils]);

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
  const place = useCallback((what: PlaceKind, page: Pt, graphicId?: number) => {
    if (!stored || !geometry || !data) return;
    setTool({ kind: "select" });
    if (what === "description") {
      const size = descriptionRect({ ...stored.description, x: page.x, y: page.y }, data.descriptionRowCount, data.descriptionHeaderRows);
      change({ description: constrainDescription({ ...stored.description, visible: true, x: page.x, y: page.y }, size.width, size.height, geometry.printable) });
      setSelection({ kind: "description" });
      return;
    }
    const o = placeObject(what, page, geometry.printable, purple, graphicId);
    if (!o) return;
    change({ objects: [...scopeObjects(data, stored).editable, o] });
    setSelection({ kind: "object", id: o.id });
  }, [stored, geometry, data, change, purple]);

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
    });
  }, [a.enabled, a.nameId, geometry, snap, scoped, block, data?.scope, selection, tool, snapping, stored, apply, change, place]);

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
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return true; }
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
  }, [tool, selection, deleteSelected, scoped, fit, onTool]);

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
    sharedHitTest: true,
    actionLayout: "bar",
    contextActions: [],
    tool: binding,
    layout: layoutRequest,
    viewRequest,
    onDismiss: () => setSelection(null),
  }), [binding, layoutRequest, viewRequest]);

  const open = useCallback((next: LayoutTarget | null) => setTarget(next), []);

  const rail = <LayoutRail tool={tool} onTool={(w) => onTool(w)} canImage={false} snapping={snapping} onSnapping={() => setSnapping((v) => !v)} />;

  // The sections keep their height (the inspector scrolls) instead of squeezing into each other.
  const inspector = (
    <div className="shrink-0 flex flex-col">
    <LayoutInspector
      loading={a.enabled && (sheets.isLoading || (!!input && query.isLoading))}
      data={data}
      snap={snap}
      geometry={geometry}
      courseName={a.course?.name ?? null}
      sheets={(sheets.data ?? []).filter((r) => (data?.sheet ? r.courseId === data.sheet.courseSeq && r.kind === data.sheet.kind : false))}
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
    />
    </div>
  );

  return { editor, rail, inspector, courseOnly: data?.sheet?.kind === "course", onKey, open, sheetCourse: data?.sheet?.courseSeq ?? null };
}

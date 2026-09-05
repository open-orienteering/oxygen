import { memo, useId, useState, useRef, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { fileToBase64 } from "../lib/file-to-base64";
import { useCurrentUser } from "../context/CurrentUserContext";
import { MapViewer, type ControlOverlay, type CourseOverlay, type MapViewerEditorProps } from "./MapViewer";
import { useIsWideViewport } from "./map-pane-shared";

/**
 * Public prop surface for `<MapPanel>`. Exported so the shell-owned
 * persistent panel and the props-pushing `<MapSlot>` share a single
 * source of truth for the contract.
 */
export interface MapPanelPublicProps {
  /** Highlight a specific control by DB ID */
  highlightControlId?: number;
  /**
   * Highlight multiple controls by DB ID. When non-empty, overrides
   * `highlightControlId` and filters the map to these controls (plus
   * start/finish). Used by the Controls page multi-select.
   */
  highlightControlIds?: number[];
  /** Highlight a specific course by name */
  highlightCourseName?: string;
  /** Highlight multiple courses by name (for forked classes) */
  highlightCourseNames?: string[];
  /** Callback when a control is clicked. Stabilize via `useCallback` to keep `memo` effective. */
  onControlClick?: (controlId: number) => void;
  /** CSS class */
  className?: string;
  /** Height for the map container (ignored when `fillContainer` is true). */
  height?: string;
  /** Auto-zoom to fit the controls area */
  fitToControls?: boolean;
  /** Initial state of the descriptions toggle (default off) */
  defaultShowDescriptions?: boolean;
  /**
   * Allow the descriptions toggle (and sheet) with no course highlighted:
   * the sheet then lists every positioned control. Used by the course
   * editor, where descriptions matter before a course is picked.
   */
  descriptionsAllControls?: boolean;
  /** Show only controls belonging to the highlighted course (when a course is highlighted) */
  filterMode?: "all" | "course" | "single-control";
  /** Show completion status overlay on controls */
  showCompletion?: boolean;
  /** Callback when completion toggle changes. Stabilize via `useCallback`. */
  onCompletionToggle?: (enabled: boolean) => void;
  /** Course ID to filter completion data by */
  completionCourseId?: number;
  /** Render a toolbar above the map (for class selectors, toggles, etc.). Stabilize via `useMemo`. */
  toolbar?: React.ReactNode;
  /**
   * Floating card rendered over the map's top-left corner. Unlike
   * `toolbar` it lives inside the map box, so it stays visible in
   * fullscreen. Stabilize via `useMemo`.
   */
  mapOverlay?: React.ReactNode;
  /**
   * Fixed modal content that must remain inside the browser fullscreen
   * subtree. Rendered as a direct child of the MapPanel fullscreen element.
   */
  fullscreenOverlay?: React.ReactNode;
  /** Per-control punch status for mispunch visualization (keyed by control code string e.g. "67") */
  punchStatusByCode?: Record<string, "ok" | "missing" | "extra">;
  /** Focus/zoom to controls with these codes (e.g. mispunched controls) */
  focusControlCodes?: string[];
  /** Hide the toolbar (filter/description/fullscreen buttons) entirely */
  hideToolbar?: boolean;
  /**
   * Show the map-name / replace-map footer row below the viewer. Only the
   * course editor needs this — other pages hide it to save vertical space.
   */
  showMapInfo?: boolean;
  /** GPS route traces to overlay on the map. */
  gpsRoutes?: Array<{ color: string; points: Array<{ lat: number; lng: number }> }>;
  /**
   * Fill the available height of the parent container instead of using
   * the fixed pixel `height` prop. Set by the shell-owned persistent
   * panel; inline call sites leave this `false` so they keep their
   * caller-defined height.
   */
  fillContainer?: boolean;
  /**
   * When set, render a small "collapse pane" button at the right edge
   * of the toolbar (after the fullscreen toggle). Only the shell-owned
   * persistent panel passes this — pages leave it `undefined`. Wired to
   * `data-testid="map-pane-collapse"` for the existing E2E tests.
   */
  onPaneCollapse?: () => void;
  /**
   * Course-editor gesture hooks, forwarded to the viewer. Only the
   * course-editor page passes this. Memoize the object (and stabilize
   * its callbacks) — MapPanel is memoized with shallow equality.
   */
  editor?: MapViewerEditorProps;
}

function MapPanelImpl({
  highlightControlId,
  highlightControlIds,
  highlightCourseName,
  highlightCourseNames,
  onControlClick,
  className = "",
  height = "600px",
  fitToControls = false,
  defaultShowDescriptions = false,
  descriptionsAllControls = false,
  filterMode: externalFilterMode,
  showCompletion = false,
  onCompletionToggle,
  completionCourseId,
  toolbar,
  mapOverlay,
  fullscreenOverlay,
  punchStatusByCode,
  focusControlCodes,
  hideToolbar = false,
  showMapInfo = false,
  gpsRoutes,
  fillContainer = false,
  onPaneCollapse,
  editor,
}: MapPanelPublicProps) {
  const { nameId } = useParams<{ nameId: string }>();
  const { t } = useTranslation("dashboard");
  const { t: tl } = useTranslation("library");
  const { user, authEnabled } = useCurrentUser();
  // Stable for the lifetime of this MapPanel instance. Exposed as
  // `data-instance-id` on every render-path root so the E2E suite can
  // assert the persistent shell-pane MapPanel doesn't remount across
  // route changes — the value rotates when (and only when) the React
  // fibre is torn down and a new one is mounted.
  const instanceId = useId();
  const isWide = useIsWideViewport();
  // When rendered inside the persistent right pane, strip caller-provided
  // layout margins (typically `mt-6`) and let the map fill the available
  // height of the pane instead of using the fixed pixel `height` prop.
  const effectiveClassName = fillContainer
    ? className.replace(/\bmt-\S+/g, "").trim()
    : className;
  const effectiveHeight = fillContainer ? "100%" : height;
  // Merge single + multi course names into a set for unified handling
  const effectiveCourseNames = useMemo(() => {
    const names = new Set<string>();
    if (highlightCourseName) names.add(highlightCourseName);
    if (highlightCourseNames) highlightCourseNames.forEach((n) => names.add(n));
    return names;
  }, [highlightCourseName, highlightCourseNames]);
  // Merge single + multi control IDs into a set for unified handling.
  // When the multi array is populated, it drives the filter (a user selecting
  // rows on the Controls page); otherwise we fall back to the single id which
  // represents the currently expanded row.
  const effectiveControlIds = useMemo(() => {
    const ids = new Set<number>();
    if (highlightControlIds && highlightControlIds.length > 0) {
      highlightControlIds.forEach((id) => ids.add(id));
    } else if (highlightControlId !== undefined) {
      ids.add(highlightControlId);
    }
    return ids;
  }, [highlightControlId, highlightControlIds]);
  // These four describe the competition's map + control layout and don't
  // change during a session except via explicit user actions (uploading a
  // new map, editing controls, adding courses) — and each of those paths
  // already invalidates the relevant cache. `staleTime: Infinity` keeps
  // the cache warm for the whole session so navigation between pages
  // doesn't refetch.
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
    enabled: !!mapInfo.data,
  });
  const controlCoords = trpc.course.controlCoordinates.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const courses = trpc.course.list.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Class → course assignments, so multi-course display can label each
  // course's legs with the classes that run it.
  const classList = trpc.class.list.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const classNamesByCourse = useMemo(() => {
    const byCourse = new Map<string, string[]>();
    if (!classList.data) return byCourse;
    for (const cls of classList.data) {
      // courseNames carries every course the class runs (forked classes
      // and course pools included); courseName is the single-course case.
      const names = cls.courseNames.length > 0 ? cls.courseNames : [cls.courseName];
      for (const courseName of names) {
        if (!courseName) continue;
        const arr = byCourse.get(courseName) ?? [];
        arr.push(cls.name);
        byCourse.set(courseName, arr);
      }
    }
    return byCourse;
  }, [classList.data]);
  // Completion status data
  const completionStatus = trpc.course.controlCompletionStatus.useQuery(
    completionCourseId ? { courseId: completionCourseId } : undefined,
    { staleTime: 10_000, refetchInterval: showCompletion ? 15_000 : false, enabled: showCompletion },
  );

  // Fetch geometry for every highlighted course so the map can draw all of
  // their routes at once (user-selecting three courses → three overlays,
  // not just the first). Returns a map keyed by course name.
  const highlightedCourseNamesList = useMemo(
    () => Array.from(effectiveCourseNames),
    [effectiveCourseNames],
  );
  const courseGeometriesQuery = trpc.course.courseGeometries.useQuery(
    { courseNames: highlightedCourseNamesList },
    { staleTime: 60_000, enabled: highlightedCourseNamesList.length > 0 },
  );
  // Merge per-course FeatureCollections into a single FeatureCollection so
  // the downstream MapViewer can keep its existing single-input contract.
  // Geometry features duplicated across courses (e.g. shared legs) are
  // fine — they just draw over each other at identical coordinates. Each
  // feature is tagged with its course name (fresh objects — the source
  // collections live in the React Query cache) so the viewer can label
  // legs per course in multi-course display.
  const courseGeometry = useMemo(() => {
    const byName = courseGeometriesQuery.data;
    if (!byName) return undefined;
    const names = Object.keys(byName);
    if (names.length === 0) return null;
    const combinedFeatures: unknown[] = [];
    for (const name of names) {
      const fc = byName[name];
      if (fc?.features) {
        for (const f of fc.features as Array<{ properties?: Record<string, unknown> }>) {
          combinedFeatures.push({
            ...f,
            properties: { ...(f.properties ?? {}), courseName: name },
          });
        }
      }
    }
    return { type: "FeatureCollection", features: combinedFeatures };
  }, [courseGeometriesQuery.data]);
  // Track which course names we actually have geometry for, so the
  // fallback leg renderer below knows which courses still need lines
  // drawn from raw control coordinates.
  const coursesWithGeometry = useMemo(() => {
    const set = new Set<string>();
    const byName = courseGeometriesQuery.data;
    if (!byName) return set;
    for (const [name, fc] of Object.entries(byName)) {
      if (fc?.features && fc.features.length > 0) set.add(name);
    }
    return set;
  }, [courseGeometriesQuery.data]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);

  // On narrow viewports, cap inline map height to nearly fill the screen
  // so the user gets maximum map real estate while one-finger page scroll
  // (over the map) still reaches content above.
  const inlineHeightStyle = useMemo((): React.CSSProperties | undefined => {
    if (fillContainer || isFullscreen) return undefined;
    if (isWide) return { height: effectiveHeight };
    const match = /^(\d+(?:\.\d+)?)px$/.exec(effectiveHeight);
    const callerPx = match ? Number(match[1]) : 600;
    return { height: `min(${callerPx}px, calc(100dvh - 8rem))` };
  }, [fillContainer, isFullscreen, isWide, effectiveHeight]);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const canQueryLibrary = !authEnabled || Boolean(user);
  const clubMaps = trpc.clubMap.list.useQuery(undefined, {
    enabled: canQueryLibrary,
    staleTime: 30_000,
  });
  const uploadMutation = trpc.course.uploadMap.useMutation({
    onSuccess: () => {
      setUploadError(null);
      mapInfo.refetch();
      mapMetadata.refetch();
    },
    onError: (err) => {
      setUploadError(`Map upload failed: ${err.message}`);
    },
  });
  const useClubMap = trpc.course.useClubMap.useMutation({
    onSuccess: () => {
      setShowLibraryPicker(false);
      setUploadError(null);
      mapInfo.refetch();
      mapMetadata.refetch();
    },
    onError: (err) => {
      setUploadError(`Map upload failed: ${err.message}`);
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Default to hiding unrelated controls when there's a highlighted selection
  const [showOnlyRelevant, setShowOnlyRelevant] = useState(true);
  const [showDescriptions, setShowDescriptions] = useState(defaultShowDescriptions);

  // Every failure path here has to end in `uploadError`. Returning
  // quietly leaves the drop zone looking untouched, which reads as "the
  // click did nothing" — the user has no way to tell a rejected file
  // from a lost one.
  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".ocd")) {
      setUploadError(`Map upload failed: ${file.name} is not an .ocd file`);
      return;
    }
    setUploadError(null);
    void fileToBase64(file)
      .then((fileDataBase64) => {
        uploadMutation.mutate({ fileName: file.name, fileDataBase64 });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setUploadError(`Map upload failed: could not read ${file.name} (${message})`);
      });
  }, [uploadMutation]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const libraryPicker = showLibraryPicker ? (
    <div
      data-testid="club-map-picker"
      className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
    >
      <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">{tl("pickerTitle")}</h2>
          <button
            type="button"
            className="text-sm text-slate-500 cursor-pointer"
            onClick={() => setShowLibraryPicker(false)}
          >
            {tl("cancel")}
          </button>
        </div>
        <ul className="divide-y divide-slate-100 max-h-80 overflow-auto">
          {(clubMaps.data ?? []).map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid={`club-map-pick-${m.id}`}
                className="w-full text-left py-2 px-1 hover:bg-slate-50 cursor-pointer"
                onClick={() => useClubMap.mutate({ clubMapId: m.id })}
              >
                <div className="font-medium text-sm text-slate-900">{m.name}</div>
                <div className="text-xs text-slate-500">
                  {m.scale
                    ? `1:${Math.round(m.scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`
                    : tl("noScale")}
                  {" · "}
                  {m.sizeBytes < 1024 * 1024
                    ? `${(m.sizeBytes / 1024).toFixed(1)} KB`
                    : `${(m.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {useClubMap.isPending && (
          <p className="text-xs text-blue-600">{t("uploading")}</p>
        )}
      </div>
    </div>
  ) : null;

  // Determine which control IDs belong to the highlighted course(s)
  const courseControlIds = useMemo(() => {
    if (effectiveCourseNames.size === 0 || !courses.data) return new Set<string>();
    const ids = new Set<string>();
    for (const course of courses.data) {
      if (effectiveCourseNames.has(course.name)) {
        for (const id of course.controls.split(";").filter(Boolean)) ids.add(id);
      }
    }
    return ids;
  }, [effectiveCourseNames, courses.data]);

  // Effective filter mode
  const filterMode = externalFilterMode ?? (
    effectiveCourseNames.size > 0 ? "course" :
      effectiveControlIds.size > 0 ? "single-control" :
        "all"
  );

  // Build control overlays from DB data
  const controlOverlays: ControlOverlay[] = useMemo(() => {
    if (!controlCoords.data) return [];
    return controlCoords.data.map((c) => {
      const id = String(c.id);
      const isHighlighted = effectiveControlIds.has(c.id);

      // Determine visibility based on filter mode and toggle
      let visible = true;
      if (showOnlyRelevant) {
        if (filterMode === "course" && courseControlIds.size > 0) {
          visible = courseControlIds.has(id) || c.status === 4 || c.status === 5;
          // Extra punch controls are not in the course but should still be visible
          if (!visible && punchStatusByCode?.[c.code] === "extra") visible = true;
        } else if (filterMode === "single-control" && effectiveControlIds.size > 0) {
          // Keep start/finish visible so the map still has useful anchor points
          // when the user is just inspecting a handful of regular controls.
          visible = effectiveControlIds.has(c.id) || c.status === 4 || c.status === 5;
        }
      }

      // Completion data for this control
      let completionPct: number | undefined;
      if (showCompletion && completionStatus.data) {
        const cs = completionStatus.data.find((s) => s.controlId === c.id);
        if (cs && cs.total > 0) {
          completionPct = cs.passed / cs.total;
        }
      }

      return {
        id,
        code: c.code,
        x: c.mapX,
        y: c.mapY,
        lat: c.lat,
        lng: c.lng,
        type: c.status === 4 ? "Start" as const : c.status === 5 ? "Finish" as const : "Control" as const,
        highlight: isHighlighted,
        visible,
        completionPct,
        punchStatus: punchStatusByCode?.[c.code],
        description: c.description,
      };
    });
  }, [controlCoords.data, effectiveControlIds, filterMode, showOnlyRelevant, courseControlIds, showCompletion, completionStatus.data, punchStatusByCode]);

  // Build course overlays — augment with start/finish connections
  const courseOverlays: CourseOverlay[] = useMemo(() => {
    if (!courses.data || !controlCoords.data) return [];

    // Identify start and finish controls
    const starts = controlCoords.data.filter((c) => c.status === 4);
    const finishes = controlCoords.data.filter((c) => c.status === 5);

    // Build position map for distance calculations
    const posMap = new Map<string, { x: number; y: number }>();
    for (const c of controlCoords.data) {
      posMap.set(String(c.id), { x: c.mapX, y: c.mapY });
    }

    // Helper: find nearest control from a list to a given position
    function findNearest(
      candidates: typeof starts,
      refPos: { x: number; y: number },
    ) {
      let best = candidates[0];
      let bestDist = Infinity;
      for (const c of candidates) {
        const dx = c.mapX - refPos.x;
        const dy = c.mapY - refPos.y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      return best;
    }

    return courses.data.map((c) => {
      const controlIds = c.controls.split(";").filter(Boolean);

      // Prepend the nearest start control
      if (starts.length > 0 && controlIds.length > 0) {
        const firstPos = posMap.get(controlIds[0]);
        if (firstPos) {
          const nearest = findNearest(starts, firstPos);
          controlIds.unshift(String(nearest.id));
        }
      }

      // Append the nearest finish control
      if (finishes.length > 0 && controlIds.length > 0) {
        const lastPos = posMap.get(controlIds[controlIds.length - 1]);
        if (lastPos) {
          const nearest = findNearest(finishes, lastPos);
          controlIds.push(String(nearest.id));
        }
      }

      return {
        name: c.name,
        controls: controlIds,
        highlight: effectiveCourseNames.has(c.name),
        classNames: classNamesByCourse.get(c.name) ?? [],
      };
    });
  }, [courses.data, controlCoords.data, effectiveCourseNames, classNamesByCourse]);

  // Compute the set of control IDs to focus on when selection changes
  const focusControlIds = useMemo(() => {
    // Editor mode: never auto-pan/zoom. The user is actively working on
    // the map, and every sequence edit would otherwise change the focus
    // set and yank the viewport around.
    if (editor) return null;
    // Mispunch focus: zoom to specific control codes
    if (focusControlCodes && focusControlCodes.length > 0 && controlCoords.data) {
      const ids = controlCoords.data
        .filter((c) => focusControlCodes.includes(c.code))
        .map((c) => String(c.id));
      if (ids.length > 0) return ids;
    }
    if (effectiveCourseNames.size > 0 && courseControlIds.size > 0 && controlCoords.data) {
      const ids = Array.from(courseControlIds);
      // Also include start/finish controls (status 4/5) so the bounding box fits the full course
      for (const c of controlCoords.data) {
        if (c.status === 4 || c.status === 5) ids.push(String(c.id));
      }
      return ids;
    }
    if (effectiveControlIds.size > 0) {
      return Array.from(effectiveControlIds, (id) => String(id));
    }
    return null;
  }, [editor, focusControlCodes, controlCoords.data, effectiveCourseNames, courseControlIds, effectiveControlIds]);

  const handleControlClick = useCallback((controlId: string) => {
    const numId = parseInt(controlId, 10);
    if (!isNaN(numId)) onControlClick?.(numId);
  }, [onControlClick]);

  const hasMap = !!mapInfo.data;
  const isLoadingMap = mapInfo.isLoading || (mapInfo.data && mapMetadata.isLoading);
  const canFilter = filterMode === "course" || filterMode === "single-control";

  // Fullscreen hooks — MUST be before any early returns to respect hook ordering rules
  const toggleFullscreen = useCallback(() => {
    if (!fullscreenRef.current) return;
    if (!document.fullscreenElement) {
      fullscreenRef.current.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen().catch(() => { });
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // While the editor is fullscreen, capture Escape via the Keyboard Lock
  // API (Chromium; Oxygen targets Chromium anyway for WebSerial) so a
  // short Esc press reaches the editor's dismissal cascade — phantom →
  // selection → course — instead of instantly dropping out of
  // fullscreen. Holding Esc still exits (browser-enforced escape hatch),
  // and the editor exits programmatically once the cascade is empty.
  // No-op where the API is unavailable.
  useEffect(() => {
    if (!editor || !isFullscreen) return;
    const kb = (
      navigator as Navigator & {
        keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void };
      }
    ).keyboard;
    if (!kb?.lock) return;
    void kb.lock(["Escape"]).catch(() => {
      /* unsupported / denied — Esc keeps its default fullscreen-exit */
    });
    return () => kb.unlock?.();
  }, [editor, isFullscreen]);

  // Highlight attribute (intent, not render outcome) — also surfaced on
  // the upload-prompt / loading-state paths so E2E tests can observe the
  // requested highlight regardless of map upload state.
  const dataHighlightCourse =
    highlightedCourseNamesList.length > 0
      ? highlightedCourseNamesList.join(",")
      : "";

  // Unified toolbar — renders on the happy path AND on the upload-prompt /
  // loading paths whenever in pane mode, so the collapse pill is always
  // accessible. Inline-mode call sites keep the legacy condition
  // (render only when the page supplied a toolbar or we're fullscreen).
  const renderToolbar = !hideToolbar && (fillContainer || toolbar || isFullscreen);
  const paneToolbar = renderToolbar ? (
    <div
      data-testid="map-toolbar"
      className="relative z-10 flex items-center gap-3 px-3 py-2 border-b border-slate-200 flex-shrink-0"
    >
      {fillContainer && !toolbar && (
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
          {t("map")}
        </h2>
      )}
      {toolbar}
      <div className="ml-auto flex items-center gap-2">
        {/* In editor mode the page drives filtering through `filterMode`
            and renders its own toggle — a second, internal toggle here
            would fight it (two buttons, diverging state). */}
        {canFilter && !editor && (
          <button
            onClick={() => setShowOnlyRelevant((v) => !v)}
            className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer ${showOnlyRelevant
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              }`}
          >
            {showOnlyRelevant ? t("showAllControls") : t("hideOtherControls")}
          </button>
        )}
        {(highlightedCourseNamesList.length > 0 || descriptionsAllControls) && (
          <button
            onClick={() => setShowDescriptions((v) => !v)}
            className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer ${showDescriptions
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              }`}
          >
            {showDescriptions ? t("hideDescriptions") : t("descriptions")}
          </button>
        )}
        {onCompletionToggle && (
          <button
            onClick={() => onCompletionToggle(!showCompletion)}
            className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer ${showCompletion
                ? "bg-emerald-100 text-emerald-700 font-medium"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              }`}
          >
            {showCompletion ? t("hideProgress") : t("showProgress")}
          </button>
        )}
        <button
          onClick={toggleFullscreen}
          className="text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" /></svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
          )}
        </button>
        {onPaneCollapse && (
          <button
            onClick={onPaneCollapse}
            data-testid="map-pane-collapse"
            title={t("hideMapPaneTitle", { ns: "nav" })}
            className="text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <span className="sr-only">{t("hideMapPane", { ns: "nav" })}</span>
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 5l7 7-7 7M5 5l7 7-7 7"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  ) : null;

  // Show upload prompt only if we're done loading and there's no map
  if (!hasMap && !isLoadingMap) {
    return (
      <div
        data-testid="map-panel"
        data-instance-id={instanceId}
        data-highlight-course={dataHighlightCourse}
        className={`${effectiveClassName} ${fillContainer ? "h-full flex flex-col" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {paneToolbar}
        <div className={fillContainer ? "flex-1 p-4 overflow-auto" : ""}>
          <div
            className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${dragOver ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-slate-50"
              }`}
          >
            <svg className="mx-auto w-10 h-10 text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            <p className="text-sm text-slate-500 mb-2">{t("dropMapHere")}</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
            >
              {t("uploadMap")}
            </button>
            {(clubMaps.data?.length ?? 0) > 0 && (
              <button
                type="button"
                data-testid="use-club-map"
                onClick={() => setShowLibraryPicker(true)}
                className="ml-2 px-3 py-1.5 text-xs border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors cursor-pointer"
              >
                {tl("fromClubLibrary")}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".ocd"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            {uploadMutation.isPending && (
              <div className="mt-2 text-xs text-blue-600">{t("uploading")}</div>
            )}
            {uploadError && (
              <div className="mt-2 text-xs text-red-600">{uploadError}</div>
            )}
          </div>
        </div>
        {libraryPicker}
      </div>
    );
  }

  // Loading state
  if (isLoadingMap) {
    return (
      <div
        data-testid="map-panel"
        data-instance-id={instanceId}
        data-highlight-course={dataHighlightCourse}
        className={`${effectiveClassName} ${fillContainer ? "h-full flex flex-col" : ""}`}
      >
        {paneToolbar}
        <div
          className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${fillContainer ? "flex-1" : ""}`}
          style={fillContainer ? undefined : { height: effectiveHeight }}
        >
          <div className="text-center">
            <div className="w-6 h-6 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin mx-auto mb-2" />
            <p className="text-xs text-slate-400">{t("loadingMap")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={fullscreenRef}
      data-testid="map-panel"
      data-instance-id={instanceId}
      data-highlight-course={dataHighlightCourse}
      className={`${effectiveClassName} ${
        fillContainer || isFullscreen ? "bg-white flex flex-col" : ""
      } ${fillContainer ? "h-full" : ""}`}
    >
      {paneToolbar}

      {/* Map viewer + floating overlays. The wrapper keeps the viewer's
          own flex sizing intact and gives absolutely positioned overlays
          (e.g. the editor's course selector) a containing block that
          follows the map into fullscreen. */}
      <div
        className={`relative ${isFullscreen || fillContainer ? "flex flex-col min-h-0" : ""}`}
        style={{ flex: isFullscreen || fillContainer ? "1 1 0" : undefined }}
      >
        <MapViewer
          key={`${nameId ?? "current"}:${mapMetadata.data?.uploadedAt ?? "loading"}:${JSON.stringify(mapMetadata.data?.bounds ?? null)}`}
          mapBounds={mapMetadata.data?.bounds}
          mapScale={mapMetadata.data?.scale}
          northOffset={mapMetadata.data?.northOffset}
          mapVersion={mapMetadata.data?.uploadedAt}
          calibration={mapMetadata.data?.calibration}
          controls={controlOverlays}
          courses={courseOverlays}
          courseGeometry={courseGeometry}
          coursesWithGeometry={coursesWithGeometry}
          highlightControlId={highlightControlId ? String(highlightControlId) : undefined}
          highlightCourseName={highlightCourseName}
          onControlClick={handleControlClick}
          className="w-full"
          style={{
            height: isFullscreen || fillContainer ? undefined : effectiveHeight,
            flex: isFullscreen || fillContainer ? "1 1 0" : undefined,
            ...inlineHeightStyle,
          }}
          initialFitControls={fitToControls}
          focusControlIds={focusControlIds}
          showDescriptions={showDescriptions}
          descriptionsAllControls={descriptionsAllControls}
          allControlsTitle={descriptionsAllControls ? t("allControls") : undefined}
          onToggleFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
          hideControls={false}
          gpsRoutes={gpsRoutes}
          editor={editor}
        />
        {mapOverlay && (
          // Spans the map's full height so a tall overlay (the editor's
          // course panel) can scroll internally instead of overflowing;
          // pointer events pass through everywhere the overlay isn't.
          // z-[8] keeps it under the editor's context menus (zIndex 9).
          <div className="absolute top-3 left-3 bottom-3 z-[8] pointer-events-none flex flex-col items-start">
            {mapOverlay}
          </div>
        )}
      </div>

      {/* Map info — below the map (course editor only) */}
      {showMapInfo && !hideToolbar && <div className="flex items-center justify-between mt-1.5 px-0.5">
        <div className="flex items-center gap-2">
          {mapInfo.data && (
            <span className="text-xs text-slate-400">{mapInfo.data.fileName}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isFullscreen && canFilter && !toolbar && (
            <button
              onClick={() => setShowOnlyRelevant((v) => !v)}
              className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer ${showOnlyRelevant
                  ? "bg-purple-100 text-purple-700 font-medium"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                }`}
            >
              {showOnlyRelevant ? t("showAllControls") : t("hideOtherControls")}
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer"
          >
            {t("replaceMap")}
          </button>
          {(clubMaps.data?.length ?? 0) > 0 && (
            <button
              type="button"
              data-testid="use-club-map"
              onClick={() => setShowLibraryPicker(true)}
              className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer"
            >
              {tl("fromClubLibrary")}
            </button>
          )}
        </div>
      </div>}

      <input
        ref={fileInputRef}
        type="file"
        accept=".ocd"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      {uploadMutation.isPending && (
        <div className="mt-1 text-xs text-blue-600">{t("uploadingNewMap")}</div>
      )}
      {uploadError && (
        <div className="mt-1 text-xs text-red-600">{uploadError}</div>
      )}
      {libraryPicker}
      {fullscreenOverlay}
    </div>
  );
}

/**
 * Default-equality `memo`. The public prop surface is mostly primitives,
 * plus a few arrays/records and React callbacks/nodes (`toolbar`,
 * `onControlClick`, `onCompletionToggle`). Callers that pass those must
 * stabilize them via `useCallback` / `useMemo`, or `memo` won't help —
 * `CompetitionDashboard` is the only current caller in that boat, and is
 * updated alongside this change.
 */
export const MapPanel = memo(MapPanelImpl);

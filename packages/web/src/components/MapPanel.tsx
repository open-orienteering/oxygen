import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { MapViewer, type ControlOverlay, type CourseOverlay } from "./MapViewer";

interface Props {
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
  /** Callback when a control is clicked */
  onControlClick?: (controlId: number) => void;
  /** CSS class */
  className?: string;
  /** Height for the map container */
  height?: string;
  /** Auto-zoom to fit the controls area */
  fitToControls?: boolean;
  /** Show only controls belonging to the highlighted course (when a course is highlighted) */
  filterMode?: "all" | "course" | "single-control";
  /** Show completion status overlay on controls */
  showCompletion?: boolean;
  /** Callback when completion toggle changes */
  onCompletionToggle?: (enabled: boolean) => void;
  /** Course ID to filter completion data by */
  completionCourseId?: number;
  /** Render a toolbar above the map (for class selectors, toggles, etc.) */
  toolbar?: React.ReactNode;
  /** Per-control punch status for mispunch visualization (keyed by control code string e.g. "67") */
  punchStatusByCode?: Record<string, "ok" | "missing" | "extra">;
  /** Focus/zoom to controls with these codes (e.g. mispunched controls) */
  focusControlCodes?: string[];
  /** Hide the toolbar (filter/description/fullscreen buttons) entirely */
  hideToolbar?: boolean;
  /** GPS route traces to overlay on the map. */
  gpsRoutes?: Array<{ color: string; points: Array<{ lat: number; lng: number }> }>;
}

export function MapPanel({
  highlightControlId,
  highlightControlIds,
  highlightCourseName,
  highlightCourseNames,
  onControlClick,
  className = "",
  height = "600px",
  fitToControls = false,
  filterMode: externalFilterMode,
  showCompletion = false,
  onCompletionToggle,
  completionCourseId,
  toolbar,
  punchStatusByCode,
  focusControlCodes,
  hideToolbar = false,
  gpsRoutes,
}: Props) {
  const { t } = useTranslation("dashboard");
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
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, {
    staleTime: 60_000,
  });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, {
    staleTime: 60_000,
    enabled: !!mapInfo.data,
  });
  const controlCoords = trpc.course.controlCoordinates.useQuery(undefined, {
    staleTime: 60_000,
  });
  const courses = trpc.course.list.useQuery(undefined, {
    staleTime: 60_000,
  });
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
  // fine — they just draw over each other at identical coordinates.
  const courseGeometry = useMemo(() => {
    const byName = courseGeometriesQuery.data;
    if (!byName) return undefined;
    const names = Object.keys(byName);
    if (names.length === 0) return null;
    const combinedFeatures: unknown[] = [];
    for (const name of names) {
      const fc = byName[name];
      if (fc?.features) combinedFeatures.push(...fc.features);
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

  const [uploadError, setUploadError] = useState<string | null>(null);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Default to hiding unrelated controls when there's a highlighted selection
  const [showOnlyRelevant, setShowOnlyRelevant] = useState(true);
  const [showDescriptions, setShowDescriptions] = useState(false);

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".ocd")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result as ArrayBuffer;
      const base64 = btoa(
        new Uint8Array(buf).reduce((data, byte) => data + String.fromCharCode(byte), ""),
      );
      uploadMutation.mutate({ fileName: file.name, fileDataBase64: base64 });
    };
    reader.readAsArrayBuffer(file);
  }, [uploadMutation]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

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
      };
    });
  }, [courses.data, controlCoords.data, effectiveCourseNames]);

  // Compute the set of control IDs to focus on when selection changes
  const focusControlIds = useMemo(() => {
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
  }, [focusControlCodes, controlCoords.data, effectiveCourseNames, courseControlIds, effectiveControlIds]);

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

  // Show upload prompt only if we're done loading and there's no map
  if (!hasMap && !isLoadingMap) {
    return (
      <div
        className={`${className}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
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
    );
  }

  // Loading state
  if (isLoadingMap) {
    return (
      <div className={`${className}`}>
        <div className="flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200" style={{ height }}>
          <div className="text-center">
            <div className="w-6 h-6 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin mx-auto mb-2" />
            <p className="text-xs text-slate-400">{t("loadingMap")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={fullscreenRef} className={`${className} ${isFullscreen ? "bg-white flex flex-col" : ""}`}>
      {/* Toolbar (class selector, toggles, etc.) — always visible, even fullscreen */}
      {!hideToolbar && (toolbar || isFullscreen) && (
        <div className="flex items-center gap-3 px-1 py-2 flex-shrink-0">
          {toolbar}
          <div className="ml-auto flex items-center gap-2">
            {canFilter && (
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
            {highlightedCourseNamesList.length > 0 && (
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
          </div>
        </div>
      )}

      {/* Map viewer */}
      <MapViewer
        mapBounds={mapMetadata.data?.bounds}
        mapScale={mapMetadata.data?.scale}
        northOffset={mapMetadata.data?.northOffset}
        mapVersion={mapMetadata.data?.uploadedAt}
        controls={controlOverlays}
        courses={courseOverlays}
        courseGeometry={courseGeometry}
        coursesWithGeometry={coursesWithGeometry}
        highlightControlId={highlightControlId ? String(highlightControlId) : undefined}
        highlightCourseName={highlightCourseName}
        onControlClick={handleControlClick}
        className="w-full"
        style={{ height: isFullscreen ? undefined : height, flex: isFullscreen ? "1 1 0" : undefined }}
        initialFitControls={fitToControls}
        focusControlIds={focusControlIds}
        showDescriptions={showDescriptions}
        onToggleFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
        hideControls={false}
        gpsRoutes={gpsRoutes}
      />

      {/* Map info — below the map */}
      {!hideToolbar && <div className="flex items-center justify-between mt-1.5 px-0.5">
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
    </div>
  );
}

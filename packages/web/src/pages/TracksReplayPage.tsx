/**
 * Full-page replay viewer within the CompetitionShell.
 *
 * URL patterns:
 *   /:nameId/tracks/replay?routeId=X     — single route (fetches livelox class via stored liveloxClassId)
 *   /:nameId/tracks/replay?classId=X     — full class (oClass ID, uses liveloxClassId from listSyncedClasses)
 *   /:nameId/tracks/replay               — class picker (no pre-selection)
 */

import { useRef, useCallback, useState, useMemo, useEffect } from "react";
import { useSearchParams, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { ReplayViewer } from "../components/replay/ReplayViewer";

export function TracksReplayPage() {
  const { nameId = "" } = useParams<{ nameId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation("tracks");

  const routeIdParam = searchParams.get("routeId");
  const classIdParam = searchParams.get("classId");

  const routeId = routeIdParam ? parseInt(routeIdParam, 10) : null;
  const classId = classIdParam ? parseInt(classIdParam, 10) : null;

  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery(undefined, {
    retry: 3,
    retryDelay: 500,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleToggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  // Sync `isFullscreen` from the actual fullscreen state, so pressing Esc
  // (which exits fullscreen at the browser level without going through
  // our handler) restores the header bar and its fullscreen toggle.
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const handleClassChange = useCallback(
    (newClassId: string) => {
      if (newClassId) {
        setSearchParams({ classId: newClassId }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    },
    [setSearchParams],
  );

  const hasContent = routeId != null || classId != null;

  return (
    <div ref={containerRef} className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header bar */}
      {!isFullscreen && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 bg-white flex-shrink-0">
          <button
            onClick={() => navigate(`/${nameId}/tracks`)}
            className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {t("backToTracks")}
          </button>

          {/* Class selector */}
          <select
            value={classId ?? ""}
            onChange={(e) => handleClassChange(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">{t("selectClass")}</option>
            {syncedClasses.data?.map((c) => (
              <option key={c.liveloxClassId ?? c.classId} value={c.classId ?? ""}>
                {c.className} ({c.routeCount})
              </option>
            ))}
          </select>

          <div className="flex-1" />
          <button
            onClick={handleToggleFullscreen}
            className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            {t("fullscreen")}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {routeId != null ? (
          <SingleRouteReplay routeId={routeId} classId={classId} nameId={nameId} />
        ) : classId != null ? (
          <ClassReplay classId={classId} nameId={nameId} />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            {hasContent ? null : t("selectClass")}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Single-route replay ──────────────────────────────────────

function SingleRouteReplay({ routeId, classId, nameId }: { routeId: number; classId: number | null; nameId: string }) {
  const { t } = useTranslation("tracks");
  const preview = trpc.livelox.getRoutePreview.useQuery({ routeId });
  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery();

  if (preview.isLoading) return <LoadingSpinner />;
  if (preview.isError || !preview.data)
    return <ErrorMessage message={preview.error?.message ?? t("failedToLoad")} />;

  // Use liveloxClassId from synced classes (matched via oClass ID) when available,
  // fall back to the preview's own liveloxClassId
  const cls = classId != null ? syncedClasses.data?.find((c) => c.classId === classId) : null;
  const liveloxClassId = cls?.liveloxClassId ?? preview.data.liveloxClassId;
  if (!liveloxClassId)
    return <ErrorMessage message={t("noLiveloxClass")} />;

  return (
    <LiveloxClassReplay
      liveloxClassId={liveloxClassId}
      filterRunnerName={preview.data.runnerName}
      nameId={nameId}
    />
  );
}

// ─── Class replay ─────────────────────────────────────────────

function ClassReplay({ classId, nameId }: { classId: number; nameId: string }) {
  const { t } = useTranslation("tracks");
  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery(undefined, {
    retry: 3,
    retryDelay: 500,
  });

  if (syncedClasses.isLoading || !syncedClasses.data) return <LoadingSpinner />;

  const cls = syncedClasses.data.find((c) => c.classId === classId);
  if (!cls?.liveloxClassId)
    return <ErrorMessage message={t("noLiveloxData")} />;

  return (
    <LiveloxClassReplay
      liveloxClassId={cls.liveloxClassId}
      filterRunnerName={null}
      nameId={nameId}
    />
  );
}

// ─── Livelox class replay (shared) ───────────────────────────

function LiveloxClassReplay({
  liveloxClassId,
  filterRunnerName,
  nameId,
}: {
  liveloxClassId: number;
  filterRunnerName: string | null;
  nameId: string;
}) {
  const { t } = useTranslation("tracks");
  const { data, isLoading, error } = trpc.livelox.importClass.useQuery(
    { classId: liveloxClassId },
    { staleTime: 10 * 60_000, retry: 1 },
  );

  // ─── Nearby mode: load all other classes ─────────────────
  const [nearbyActive, setNearbyActive] = useState(false);

  // Fetch list of all synced classes (cached — already loaded by parent)
  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery(undefined, {
    staleTime: 10 * 60_000,
  });

  // IDs of other classes to load (empty unless nearby is active)
  const otherClassIds = useMemo(() => {
    if (!nearbyActive || !syncedClasses.data) return [] as number[];
    return syncedClasses.data
      .map((c) => c.liveloxClassId)
      .filter((id): id is number => id != null && id !== liveloxClassId);
  }, [nearbyActive, syncedClasses.data, liveloxClassId]);

  // Load all other class route data in parallel (react-query caches each result)
  const otherClassResults = trpc.useQueries((t) =>
    otherClassIds.map((id) =>
      t.livelox.importClass({ classId: id }, { staleTime: 10 * 60_000, retry: 1 }),
    ),
  );

  const extraRoutes = useMemo(
    () => otherClassResults.flatMap((r) => r.data?.routes ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [otherClassResults],
  );

  const extraRoutesLoading = nearbyActive && otherClassResults.some((r) => r.isLoading);

  // All hooks MUST be called before any early return (React rules of hooks).
  const replayConfig = useMemo(() => {
    if (!data) return { autoPlay: true } as import("../components/replay/useReplayState").ReplayConfig;
    const cfg: import("../components/replay/useReplayState").ReplayConfig = {
      autoPlay: true,
    };
    if (filterRunnerName?.trim()) {
      const norm = (s: string) => s.toLowerCase().trim();
      const first = norm(filterRunnerName.split(" ")[0] ?? "");
      const matchedIds = data.routes
        .filter((r) =>
          norm(r.name).includes(first) ||
          norm(filterRunnerName).includes(norm(r.name.split(" ")[0] ?? "")),
        )
        .map((r) => r.participantId);
      if (matchedIds.length > 0) {
        cfg.initialVisibleIds = matchedIds;
      }
    }
    return cfg;
  }, [data, filterRunnerName]);

  if (isLoading) return <LoadingSpinner />;
  if (error || !data)
    return <ErrorMessage message={error?.message ?? t("failedToLoadLivelox")} />;

  return (
    <ReplayViewer
      data={data}
      replayConfig={replayConfig}
      nativeTileBase={nameId ? `/api/map-tile/${nameId}` : undefined}
      extraRoutes={extraRoutes}
      extraRoutesLoading={extraRoutesLoading}
      onNearbyModeChange={setNearbyActive}
    />
  );
}

// ─── Shared UI ───────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full text-slate-400 text-sm">
      {message}
    </div>
  );
}

import { useState, useMemo, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { MapSlot } from "../components/MapSlot";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createTrackAnchors, type TrackRow } from "../lib/structured-search/anchors/track-anchors";

export function TracksPage() {
  const { t } = useTranslation("tracks");

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const anchors = useMemo(() => createTrackAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<TrackRow>(
    anchors,
    ["runnerName", "organisation", "className"],
  );

  const syncedClasses = trpc.tracks.listSyncedClasses.useQuery();
  const routes = trpc.tracks.listRoutes.useQuery();
  const deleteRoute = trpc.tracks.deleteRoute.useMutation({
    onSuccess: () => routes.refetch(),
  });

  // Persistent-pane wiring. Hoisted from `ExpandedDetail` so the
  // page-level `<MapSlot>` below publishes something *for every*
  // TracksPage render — not just when a row is expanded — which keeps
  // the shell-owned MapPanel from unmounting whenever the user collapses
  // the row or first lands on Tracks. `mapMetadata` is cached forever
  // by MapPanel itself (`staleTime: Infinity`), so this query is free
  // after first load; we use it here to know whether ExpandedDetail
  // should render the inline map fallback.
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const hasOcdMap = mapMetadata.data != null;

  const expandedPreview = trpc.tracks.getRoutePreview.useQuery(
    { routeId: expandedId ?? 0 },
    { enabled: !!expandedId, staleTime: 60_000 },
  );

  // Single-track GPS overlay for the persistent pane. Red is the
  // app-wide single-track colour (matches RunnerMapPreview /
  // CardMapPreview, and the multi-runner replay view uses its own
  // per-runner colours via ReplayRouteLayer instead).
  const gpsRoutes = useMemo(() => {
    if (!expandedPreview.data) return undefined;
    return [
      {
        color: "#e6194b",
        points: expandedPreview.data.waypoints.map((w) => ({
          lat: w.lat,
          lng: w.lng,
        })),
      },
    ];
  }, [expandedPreview.data]);

  const highlightCourseName =
    expandedPreview.data?.courseName ?? undefined;

  const suggestionData = useMemo(
    () => ({
      classes: syncedClasses.data?.map((c) => ({ id: c.classId, name: c.className })) ?? [],
      clubs: routes.data
        ? Array.from(new Set(routes.data.map((r) => r.organisation))).map((name) => ({ name }))
        : [],
    }),
    [syncedClasses.data, routes.data],
  );

  const filtered = useMemo(() => {
    if (!routes.data) return [];
    return filterItems(routes.data as TrackRow[]);
  }, [routes.data, filterItems]);

  const comparators = useMemo(
    () => ({
      name: (a: (typeof filtered)[0], b: (typeof filtered)[0]) => {
        // Sort empty/null names last
        if (!a.runnerName && !b.runnerName) return 0;
        if (!a.runnerName) return 1;
        if (!b.runnerName) return -1;
        return a.runnerName.localeCompare(b.runnerName);
      },
      club: (a: (typeof filtered)[0], b: (typeof filtered)[0]) =>
        a.organisation.localeCompare(b.organisation),
      class: (a: (typeof filtered)[0], b: (typeof filtered)[0]) =>
        a.className.localeCompare(b.className),
      time: (a: (typeof filtered)[0], b: (typeof filtered)[0]) =>
        (a.result?.timeMs ?? Infinity) - (b.result?.timeMs ?? Infinity),
      status: (a: (typeof filtered)[0], b: (typeof filtered)[0]) =>
        (a.result?.status ?? "zzz").localeCompare(b.result?.status ?? "zzz"),
    }),
    [],
  );

  const { sorted, sort, toggle } = useSort(
    filtered,
    { key: "name", dir: "asc" },
    comparators,
  );

  const handleDelete = (id: number, name: string) => {
    if (!confirm(t("deleteConfirm", { name: name || t("unknown") }))) return;
    deleteRoute.mutate({ routeId: id });
    if (expandedId === id) setExpandedId(null);
  };

  if (routes.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Persistent map preview. Always pushed — even with no row
          expanded — so the shell pane stays mounted while the user is
          on Tracks (and across navigation in and out of Tracks). When a
          row is expanded, `gpsRoutes` and `highlightCourseName` start
          driving the overlay; otherwise the panel just shows the
          competition map. */}
      <MapSlot
        fitToControls={false}
        gpsRoutes={gpsRoutes}
        highlightCourseName={highlightCourseName}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
        <div className="shrink-0">
          <h2 className="text-lg font-semibold text-slate-900">{t("title")}</h2>
          <p className="text-sm text-slate-500">
            {t("routeCount", { count: filtered.length })}
          </p>
        </div>
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchPlaceholder")}
          suggestionData={suggestionData}
        />
      </div>

      {/* No data states */}
      {routes.data?.length === 0 && (
        <div className="text-center py-16 text-slate-400 text-sm">
          {t("noRoutesSynced")}
        </div>
      )}

      {routes.data && routes.data.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12 text-slate-400 text-sm">
          {t("noRoutesMatch")}
        </div>
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide">
                <SortHeader
                  label={t("name")}
                  active={sort.key === "name"}
                  direction={sort.dir}
                  onClick={() => toggle("name")}
                />
                <SortHeader
                  label={t("club")}
                  active={sort.key === "club"}
                  direction={sort.dir}
                  onClick={() => toggle("club")}
                />
                <SortHeader
                  label={t("class")}
                  active={sort.key === "class"}
                  direction={sort.dir}
                  onClick={() => toggle("class")}
                />
                <SortHeader
                  label={t("time")}
                  active={sort.key === "time"}
                  direction={sort.dir}
                  onClick={() => toggle("time")}
                />
                <SortHeader
                  label={t("status")}
                  active={sort.key === "status"}
                  direction={sort.dir}
                  onClick={() => toggle("status")}
                />
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((route) => {
                const isExpanded = expandedId === route.id;
                return (
                  <Fragment key={route.id}>
                    <tr
                      className={`hover:bg-slate-50 cursor-pointer transition-colors ${isExpanded ? "bg-slate-50" : ""}`}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : route.id)
                      }
                    >
                      <td className="px-4 py-2.5 font-medium text-slate-900">
                        <span className="mr-1.5 text-slate-400 text-xs">
                          {isExpanded ? "▾" : "▸"}
                        </span>
                        {route.runnerName || (
                          <span className="text-slate-400 italic">{t("unknown")}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {route.organisation}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {route.className}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">
                        {route.result?.timeMs != null
                          ? formatTime(route.result.timeMs)
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {route.result?.status != null ? (
                          <StatusBadge status={route.result.status} />
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() =>
                            handleDelete(route.id, route.runnerName)
                          }
                          disabled={deleteRoute.isPending}
                          className="px-2.5 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          {t("delete")}
                        </button>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr>
                        <td colSpan={6} className="px-4 pb-4 pt-2 bg-slate-50">
                          <ExpandedDetail
                            preview={expandedPreview.data ?? null}
                            isPreviewLoading={expandedPreview.isLoading}
                            hasOcdMap={hasOcdMap}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Expanded detail row ──────────────────────────────────────

interface RoutePreviewData {
  raceStartMs: number | null;
  waypoints: { lat: number; lng: number; t?: number }[];
  courseName: string | null;
}

function ExpandedDetail({
  preview,
  isPreviewLoading,
  hasOcdMap,
}: {
  preview: RoutePreviewData | null;
  isPreviewLoading: boolean;
  hasOcdMap: boolean;
}) {
  const { t } = useTranslation("tracks");

  return (
    <div className="space-y-3">
      {/* While the preview is still loading we briefly show a spinner
          so the row doesn't visually collapse mid-fetch. */}
      {isPreviewLoading && !preview && (
        <div className="h-[80px] flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200">
          <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}

      {/* Without an .ocd map there is no background to draw the track on.
          The common case — .ocd uploaded — is handled by the page-level
          `<MapSlot>`, which drives the shell's persistent MapPanel. */}
      {!hasOcdMap && preview && (
        <div className="h-[120px] flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200 text-slate-400 text-sm">
          {t("noMapAvailable")}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function formatTime(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function StatusBadge({ status }: { status: "ok" | "mp" | "dnf" | "dns" | "dq" | "unknown" }) {
  const map: Record<string, { label: string; cls: string }> = {
    ok:      { label: "OK",  cls: "bg-green-100 text-green-700" },
    mp:      { label: "MP",  cls: "bg-amber-100 text-amber-700" },
    dnf:     { label: "DNF", cls: "bg-red-100 text-red-700" },
    dns:     { label: "DNS", cls: "bg-slate-100 text-slate-500" },
    dq:      { label: "DQ",  cls: "bg-red-100 text-red-700" },
    unknown: { label: "?",   cls: "bg-slate-100 text-slate-500" },
  };
  const cfg = map[status] ?? { label: status.toUpperCase(), cls: "bg-slate-100 text-slate-500" };
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

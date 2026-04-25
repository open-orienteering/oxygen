import { useState, useMemo, Fragment } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { TrackMapPanel } from "../components/TrackMapPanel";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createTrackAnchors, type TrackRow } from "../lib/structured-search/anchors/track-anchors";

export function TracksPage() {
  const { nameId = "" } = useParams<{ nameId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation("tracks");

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const anchors = useMemo(() => createTrackAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<TrackRow>(
    anchors,
    ["runnerName", "organisation", "className"],
  );

  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery();
  const routes = trpc.livelox.listRoutes.useQuery();
  const deleteRoute = trpc.livelox.deleteRoute.useMutation({
    onSuccess: () => routes.refetch(),
  });

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
        <button
          onClick={() => navigate(`/${nameId}/tracks/replay`)}
          className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer whitespace-nowrap"
        >
          {t("openClassReplay")}
        </button>
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
                            route={route}
                            nameId={nameId}
                            onNavigate={navigate}
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

interface RouteRow {
  id: number;
  runnerId: number | null;
  runnerName: string;
  organisation: string;
  classId: number | null;
  className: string;
  liveloxClassId: number | null;
  color: string;
  raceStartMs: number | null;
  result: {
    status: "ok" | "mp" | "dnf" | "dns" | "dq" | "unknown";
    timeMs?: number;
    rank?: number;
    splitTimes?: { controlCode: string; timeMs: number }[];
  } | null;
  syncedAt: string | Date;
}

function ExpandedDetail({
  route,
  nameId,
  onNavigate,
}: {
  route: RouteRow;
  nameId: string;
  onNavigate: ReturnType<typeof useNavigate>;
}) {
  const { t } = useTranslation("tracks");
  const preview = trpc.livelox.getRoutePreview.useQuery({ routeId: route.id });

  const previewRoute = preview.data
    ? {
        color: "#e6194b",
        raceStartMs: preview.data.raceStartMs,
        waypoints: preview.data.waypoints,
        interruptions: preview.data.interruptions,
        liveloxClassId: preview.data.liveloxClassId,
        runnerName: route.runnerName,
        courseName: preview.data.courseName,
      }
    : null;

  return (
    <div className="space-y-3">
      {previewRoute ? (
        <TrackMapPanel route={previewRoute} height="640px" />
      ) : (
        <div className="h-[640px] flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200">
          <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}

      <div className="flex gap-2">
        {route.liveloxClassId && (
          <>
            <button
              onClick={() =>
                onNavigate(`/${nameId}/tracks/replay?routeId=${route.id}${route.classId ? `&classId=${route.classId}` : ""}`)
              }
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
            >
              {t("openReplay")}
            </button>
            {route.classId && (
              <button
                onClick={() =>
                  onNavigate(`/${nameId}/tracks/replay?classId=${route.classId}`)
                }
                className="px-3 py-1.5 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
              >
                {t("fullClassReplay")}
              </button>
            )}
          </>
        )}
      </div>
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

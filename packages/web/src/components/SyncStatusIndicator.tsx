import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { useEventQueue } from "../hooks/useEventQueue";

interface CachedQueryInfo {
  label: string;
  key: string;
  count: number | null;
  updatedAt: number;
  stale: boolean;
}

function formatTimeAgo(ts: number, justNow: string, never: string): string {
  if (ts === 0) return never;
  const diff = Date.now() - ts;
  if (diff < 10_000) return justNow;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3600_000)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extract info about cached tRPC queries from the React Query cache.
 */
function getCachedQueries(queryClient: ReturnType<typeof useQueryClient>): CachedQueryInfo[] {
  const allQueries = queryClient.getQueryCache().getAll();

  // Queries we care about for station offline
  const trackedKeys: Record<string, string> = {
    "competition.dashboard": "Dashboard",
    "competition.clubs": "Clubs",
    "competition.getRegistrationConfig": "Registration config",
    "runner.list": "Runners",
    "control.list": "Controls",
    "eventor.runnerDbDump": "Runner DB",
  };

  // Deduplicate: tRPC may create multiple cache entries for the same query
  // (e.g. from useStationSync + component's own useQuery). Keep the most recent.
  const byKey = new Map<string, CachedQueryInfo>();

  for (const query of allQueries) {
    const k = query.queryKey;
    if (!Array.isArray(k) || !Array.isArray(k[0])) continue;
    const keyStr = (k[0] as string[]).join(".");
    const label = trackedKeys[keyStr];
    if (!label) continue;

    const data = query.state.data;
    let count: number | null = null;
    if (Array.isArray(data)) {
      count = data.length;
    } else if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if ("totalRunners" in d) count = d.totalRunners as number;
      else if ("classes" in d && Array.isArray(d.classes)) count = (d.classes as unknown[]).length;
    }

    const existing = byKey.get(keyStr);
    if (!existing || query.state.dataUpdatedAt > existing.updatedAt) {
      byKey.set(keyStr, {
        label,
        key: keyStr,
        count,
        updatedAt: query.state.dataUpdatedAt,
        stale: query.isStale(),
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function SyncStatusIndicator({ competitionId }: { competitionId?: string }) {
  const { t } = useTranslation("common");
  const isOnline = useOnlineStatus();
  const { pendingCount, syncing, manualDrain } = useEventQueue(competitionId);
  const queryClient = useQueryClient();
  const [showPanel, setShowPanel] = useState(false);
  const [cachedQueries, setCachedQueries] = useState<CachedQueryInfo[]>([]);
  const [totalCacheEntries, setTotalCacheEntries] = useState(0);

  // Refresh cache info when panel is open
  useEffect(() => {
    if (!showPanel) return;
    const refresh = () => {
      setCachedQueries(getCachedQueries(queryClient));
      setTotalCacheEntries(queryClient.getQueryCache().getAll().length);
    };
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [showPanel, queryClient]);

  // Estimate total cached data size
  const estimatedSize = useCallback(() => {
    let total = 0;
    for (const q of queryClient.getQueryCache().getAll()) {
      if (q.state.data) {
        try {
          total += JSON.stringify(q.state.data).length * 2; // rough UTF-16 estimate
        } catch { /* circular refs etc */ }
      }
    }
    return total;
  }, [queryClient]);

  // Oldest update time among tracked queries
  const oldestUpdate = cachedQueries.length > 0
    ? Math.min(...cachedQueries.map((q) => q.updatedAt).filter((t) => t > 0))
    : 0;

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
          isOnline
            ? pendingCount > 0
              ? "text-amber-700 bg-amber-50 hover:bg-amber-100"
              : "text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
            : "text-amber-700 bg-amber-50 hover:bg-amber-100"
        }`}
        title={t("syncStatus")}
      >
        {isOnline && pendingCount === 0 && (
          <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
        )}
        {/* Cloud icon */}
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {isOnline ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          ) : (
            <>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364L5.636 5.636" />
            </>
          )}
        </svg>
        {pendingCount > 0 && (
          <span className="bg-amber-500 text-white px-1.5 py-0.5 rounded-full text-[10px] leading-none font-bold">
            {pendingCount}
          </span>
        )}
      </button>

      {showPanel && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setShowPanel(false)} />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg min-w-[320px]">
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">{t("syncStatus")}</h3>
                <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                  isOnline ? "text-emerald-600" : "text-amber-600"
                }`}>
                  <span className={`w-2 h-2 rounded-full ${
                    isOnline ? "bg-emerald-500" : "bg-amber-500"
                  } ${isOnline ? "animate-pulse" : ""}`} />
                  {isOnline ? t("connected") : t("offline")}
                </span>
              </div>
              {oldestUpdate > 0 && (
                <div className="text-xs text-slate-500 mt-1">
                  {t("lastSynced")}: {formatTimeAgo(oldestUpdate, t("justNow"), t("neverSynced"))}
                </div>
              )}
            </div>

            {/* Pending Events */}
            {pendingCount > 0 && (
              <div className="px-4 py-3 border-b border-slate-100 bg-amber-50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-amber-800">{t("pendingEvents")}</div>
                    <div className="text-lg font-bold text-amber-900 tabular-nums">{pendingCount}</div>
                  </div>
                  {isOnline && (
                    <button
                      onClick={(e) => { e.stopPropagation(); manualDrain(); }}
                      disabled={syncing}
                      className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
                    >
                      {syncing ? t("syncing") : t("syncNow")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Cached Data Table */}
            <div className="px-4 py-3">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                {t("cachedData")}
              </div>
              <div className="space-y-1.5">
                {cachedQueries.map((q) => (
                  <div key={q.key} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        q.updatedAt === 0
                          ? "bg-slate-300"
                          : q.stale
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                      }`} />
                      <span className="text-slate-700">{q.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-slate-500">
                      {q.count !== null && (
                        <span className="tabular-nums">{q.count} {t("items")}</span>
                      )}
                      <span className="tabular-nums w-12 text-right">
                        {formatTimeAgo(q.updatedAt, t("justNow"), t("neverSynced"))}
                      </span>
                    </div>
                  </div>
                ))}
                {cachedQueries.length === 0 && (
                  <div className="text-xs text-slate-400 italic">No cached data</div>
                )}
              </div>
            </div>

            {/* Footer — cache stats */}
            <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 rounded-b-lg">
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{t("cacheSize")}: ~{formatBytes(showPanel ? estimatedSize() : 0)}</span>
                <span>{totalCacheEntries} {t("entries")}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

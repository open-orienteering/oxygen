import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatDateTime } from "../lib/format";
import { useTimeAgo } from "../hooks/useTimeAgo";
import { ClubLogo } from "../components/ClubLogo";

export function EventPage() {
  const { t } = useTranslation("event");
  const dashboard = trpc.competition.dashboard.useQuery();
  const syncStatus = trpc.eventor.syncStatus.useQuery();

  if (dashboard.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!dashboard.data) return null;

  const d = dashboard.data;

  return (
    <div className="space-y-6">
      {/* Competition Info */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
          {t("competitionInfo")}
        </h2>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-start gap-5">
            {d.organizer && d.organizer.eventorId > 0 && (
              <ClubLogo
                eventorId={d.organizer.eventorId}
                size="lg"
                className="rounded flex-shrink-0 mt-0.5"
              />
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-slate-900 leading-tight">
                {d.competition.name}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                <span>{d.competition.date}</span>
                {d.organizer && (
                  <span>{d.organizer.name}</span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>{t("database")}: <span className="font-mono">{d.competition.nameId}</span></span>
                {d.competition.annotation && (
                  <span>{d.competition.annotation}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sync Section */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
          {t("dataSync")}
        </h2>
        <div className="space-y-4">
          {/* Eventor Sync */}
          {syncStatus.data?.linked && (
            <EventorSyncPanel
              eventorEventId={syncStatus.data.eventorEventId}
              lastSync={syncStatus.data.lastSync}
              apiKeyConfigured={syncStatus.data.apiKeyConfigured}
              env={syncStatus.data.env}
              onSynced={() => {
                dashboard.refetch();
                syncStatus.refetch();
              }}
            />
          )}

          {/* Global Runner Database */}
          {syncStatus.data?.apiKeyConfigured && (
            <RunnerDbPanel env={syncStatus.data.env} />
          )}

          {/* Club sync (from clubs page) */}
          <ClubSyncPanel env={syncStatus.data?.env} />

          {/* LiveResults Sync */}
          <LiveResultsPanel />

        </div>
      </div>


      {/* Registration & Payment */}
      <RegistrationPaymentSettings />

      {/* Receipts & Printing */}
      <ReceiptSettings />

      {/* Google Sheets Backup */}
      <GoogleSheetsBackup />

      {/* Livelox GPS Routes */}
      <LiveloxSection eventorEventId={syncStatus.data?.linked ? syncStatus.data.eventorEventId : null} />
    </div>
  );
}

// ─── Sync Behavior Help ─────────────────────────────────────

function SyncBehaviorHelp() {
  const { t } = useTranslation("event");
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 cursor-pointer"
      >
        <svg width={13} height={13} viewBox="0 0 20 20" fill="currentColor" className="shrink-0">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
        </svg>
        {open ? t("hideSyncDetails") : t("howDoesSyncWork")}
      </button>

      {open && (
        <div className="mt-2 p-3 bg-white border border-blue-100 rounded-lg space-y-3 text-xs text-slate-700">
          <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">{t("whatGetsSyncedFromEventor")}</p>

          <div className="space-y-2">
            <SyncRow icon="👤" label={t("syncRunners")} detail={t("syncRunnersDetail")} />
            <SyncRow icon="💳" label={t("syncFees")} detail={t("syncFeesDetail")} />
            <SyncRow icon="🏷️" label={t("syncBib")} detail={t("syncBibDetail")} />
            <SyncRow icon="🏅" label={t("syncRanking")} detail={t("syncRankingDetail")} />
            <SyncRow icon="⏱️" label={t("results")} detail={t("syncResultsDetail")} />
            <SyncRow icon="🔵" label={t("syncClassesClubs")} detail={t("syncClassesClubsDetail")} />
          </div>

          <div className="border-t border-slate-100 pt-2 space-y-2">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">{t("specialStatusHandling")}</p>
            <SyncRow icon="🚫" label={t("syncWithdrawn")} detail={t("syncWithdrawnDetail")} />
            <SyncRow icon="🔇" label={t("syncNoTiming")} detail={t("syncNoTimingDetail")} />
          </div>

          <div className="border-t border-slate-100 pt-2 space-y-2">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">{t("whatGetsPushedToEventor")}</p>
            <SyncRow icon="⏱️" label={t("results")} detail={t("pushResultsDetail")} />
            <SyncRow icon="🔀" label={t("pushSplitTimes")} detail={t("pushSplitTimesDetail")} />
            <SyncRow icon="💳" label={t("syncFees")} detail={t("pushFeesDetail")} />
            <SyncRow icon="👤" label={t("pushPersonDetails")} detail={t("pushPersonDetailsDetail")} />
          </div>

          <div className="border-t border-slate-100 pt-2 space-y-2">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">{t("whatIsNotSynced")}</p>
            <SyncRow icon="🌊" label={t("syncStartGroups")} detail={t("syncStartGroupsDetail")} />
          </div>

          <p className="text-[10px] text-slate-400 border-t border-slate-100 pt-2">
            {t("syncExplanation")}
          </p>
        </div>
      )}
    </div>
  );
}

function SyncRow({ icon, label, detail }: { icon: string; label: string; detail: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-base leading-none mt-0.5">{icon}</span>
      <div>
        <span className="font-semibold text-slate-700">{label}</span>
        <span className="text-slate-500"> — {detail}</span>
      </div>
    </div>
  );
}

// ─── Eventor Sync Panel ─────────────────────────────────────

function EventorSyncPanel({
  eventorEventId,
  lastSync,
  apiKeyConfigured,
  env,
  onSynced,
}: {
  eventorEventId: number;
  lastSync: string | null;
  apiKeyConfigured: boolean;
  env: string;
  onSynced: () => void;
}) {
  const { t } = useTranslation("event");
  const timeAgo = useTimeAgo();
  const syncMutation = trpc.eventor.sync.useMutation({
    onSuccess: () => onSynced(),
  });
  const pushResultsMutation = trpc.eventor.pushResults.useMutation();
  const pushStartListMutation = trpc.eventor.pushStartList.useMutation();

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastSync) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [lastSync]);

  return (
    <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {t("eventorLinked")}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {t("eventNumber", { id: eventorEventId })}
              </span>
              {env === "test" && (
                <span className="ml-2 px-1 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase">
                  {t("testEventor")}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500">
              {t("lastSync")}:{" "}
              {lastSync
                ? <>{formatDateTime(lastSync)} <span className="text-slate-400">({timeAgo(lastSync)})</span></>
                : t("lastSyncNever")}
            </div>
          </div>

          <SyncBehaviorHelp />
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !apiKeyConfigured}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap"
          >
            {syncMutation.isPending ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("syncing")}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {t("syncFromEventor")}
              </>
            )}
          </button>

          <button
            onClick={() => pushStartListMutation.mutate()}
            disabled={pushStartListMutation.isPending || !apiKeyConfigured}
            className="px-4 py-2 bg-slate-600 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap"
          >
            {pushStartListMutation.isPending ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("pushing")}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {t("pushStartList")}
              </>
            )}
          </button>

          <button
            onClick={() => pushResultsMutation.mutate()}
            disabled={pushResultsMutation.isPending || !apiKeyConfigured}
            className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap"
          >
            {pushResultsMutation.isPending ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("pushing")}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                {t("pushResults")}
              </>
            )}
          </button>
        </div>
      </div>

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-blue-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">{t("syncComplete")}</span>{" "}
          {syncMutation.data.runnersAdded > 0 && <span>{t("runnersAdded", { count: syncMutation.data.runnersAdded })}, </span>}
          {syncMutation.data.runnersUpdated > 0 && <span>{t("runnersUpdated", { count: syncMutation.data.runnersUpdated })}, </span>}
          {syncMutation.data.cancelledCount > 0 && <span className="text-amber-700">{t("cancelledCount", { count: syncMutation.data.cancelledCount })}, </span>}
          {syncMutation.data.classesAdded > 0 && <span>{t("classesAdded", { count: syncMutation.data.classesAdded })}, </span>}
          {syncMutation.data.classesUpdated > 0 && <span>{t("classesUpdated", { count: syncMutation.data.classesUpdated })}, </span>}
          {syncMutation.data.clubsAdded > 0 && <span>{t("clubsAdded", { count: syncMutation.data.clubsAdded })}, </span>}
          {syncMutation.data.clubsUpdated > 0 && <span>{t("clubsUpdated", { count: syncMutation.data.clubsUpdated })}, </span>}
          {syncMutation.data.runnersAdded === 0 &&
            syncMutation.data.runnersUpdated === 0 &&
            syncMutation.data.cancelledCount === 0 &&
            syncMutation.data.classesAdded === 0 &&
            syncMutation.data.clubsAdded === 0 && <span>{t("everythingUpToDate")}</span>}
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          {t("syncFailed", { message: syncMutation.error.message })}
        </div>
      )}

      {pushStartListMutation.isSuccess && pushStartListMutation.data && (
        <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700">
          <span className="font-medium">{t("pushComplete")}</span> {t("pushStartListComplete", { count: pushStartListMutation.data.runnerCount })}
        </div>
      )}

      {pushStartListMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          {t("pushStartListFailed", { message: pushStartListMutation.error.message })}
        </div>
      )}

      {pushResultsMutation.isSuccess && pushResultsMutation.data && (
        <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800">
          <span className="font-medium">{t("pushComplete")}</span> {t("pushResultsComplete", { count: pushResultsMutation.data.runnerCount })}
        </div>
      )}

      {pushResultsMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          {t("pushResultsFailed", { message: pushResultsMutation.error.message })}
        </div>
      )}

      {!apiKeyConfigured && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 p-2 rounded-lg">
          {t("eventorApiKeyNotConfigured")}
        </div>
      )}
    </div>
  );
}

// ─── Runner Database Panel ──────────────────────────────────

function RunnerDbPanel({ env }: { env?: string }) {
  const { t } = useTranslation("event");
  const timeAgo = useTimeAgo();
  const dbStatus = trpc.eventor.runnerDbStatus.useQuery(undefined, {
    staleTime: 60_000,
  });
  const syncMutation = trpc.eventor.syncRunnerDb.useMutation({
    onSuccess: () => dbStatus.refetch(),
  });

  const handleSync = () => {
    syncMutation.mutate({ env: (env as any) || "prod" });
  };

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!dbStatus.data?.lastSync) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [dbStatus.data?.lastSync]);

  return (
    <div className="bg-purple-50 rounded-xl border border-purple-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {t("runnerDatabase")}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {t("runnerDatabaseGlobal")}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {dbStatus.data?.runnerCount
                ? (
                  <>
                    {t("runnerDbStats", { runners: dbStatus.data.runnerCount.toLocaleString(), clubs: dbStatus.data.clubCount.toLocaleString() })}
                    {dbStatus.data.lastSync && (
                      <span className="text-slate-400">
                        {" "}— {t("runnerDbSynced", { ago: timeAgo(dbStatus.data.lastSync) })}
                      </span>
                    )}
                  </>
                )
                : t("runnerDbNotSynced")}
            </div>
          </div>
        </div>

        <button
          onClick={handleSync}
          disabled={syncMutation.isPending}
          className="px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2"
        >
          {syncMutation.isPending ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {t("syncing")}
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {dbStatus.data?.runnerCount ? t("reSync") : t("download")}
            </>
          )}
        </button>
      </div>

      {syncMutation.isPending && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-purple-100 text-xs text-slate-600 flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
          {t("downloadingRunnerDb")}
        </div>
      )}

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-purple-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">{t("syncComplete")}</span>{" "}
          {t("runnerDbSyncComplete", { runners: syncMutation.data.runners.toLocaleString(), clubs: syncMutation.data.clubs.toLocaleString() })}
          {syncMutation.data.logosAdded > 0 && (
            <>, {t("logosDownloaded", { count: syncMutation.data.logosAdded })}</>
          )}
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          {t("syncFailed", { message: syncMutation.error.message })}
        </div>
      )}
    </div>
  );
}

// ─── LiveResults Panel ────────────────────────────────────────

function LiveResultsPanel() {
  const { t } = useTranslation("event");
  const timeAgo = useTimeAgo();
  const config = trpc.liveresults.getConfig.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const status = trpc.liveresults.getStatus.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const enableMut = trpc.liveresults.enable.useMutation({
    onSuccess: () => { config.refetch(); status.refetch(); },
  });
  const disableMut = trpc.liveresults.disable.useMutation({
    onSuccess: () => { config.refetch(); status.refetch(); },
  });
  const saveMut = trpc.liveresults.saveConfig.useMutation({
    onSuccess: () => config.refetch(),
  });
  const pushNowMut = trpc.liveresults.pushNow.useMutation({
    onSuccess: () => status.refetch(),
  });

  const [intervalSeconds, setIntervalSeconds] = useState<number | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | null>(null);

  useEffect(() => {
    if (config.data && intervalSeconds === null) {
      setIntervalSeconds(config.data.intervalSeconds);
      setCountry(config.data.country);
      setIsPublic(config.data.isPublic);
    }
  }, [config.data, intervalSeconds]);

  const running = status.data?.running ?? false;
  const tavid = status.data?.tavid ?? config.data?.tavid ?? null;
  const publicUrl = status.data?.publicUrl ?? config.data?.publicUrl ?? null;
  const isBusy =
    enableMut.isPending || disableMut.isPending || saveMut.isPending || pushNowMut.isPending;

  const handleToggle = async () => {
    if (running) {
      disableMut.mutate();
    } else {
      if (
        intervalSeconds !== config.data?.intervalSeconds ||
        country !== config.data?.country ||
        isPublic !== config.data?.isPublic
      ) {
        await saveMut.mutateAsync({
          intervalSeconds: intervalSeconds ?? 30,
          country: country ?? "SE",
          isPublic: isPublic ?? false,
        });
      }
      enableMut.mutate();
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
          </svg>
          <span className="text-sm font-semibold text-slate-800">{t("liveResults")}</span>
          {tavid && <span className="text-xs text-slate-400 font-mono">#{tavid}</span>}
        </div>
        <button
          onClick={() => void handleToggle()}
          disabled={isBusy}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${running ? "bg-green-500" : "bg-slate-200"
            } disabled:opacity-50`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${running ? "translate-x-6" : "translate-x-1"
              }`}
          />
        </button>
      </div>

      {/* Live status bar */}
      {running && (
        <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span>{t("live")}</span>
          {status.data?.lastPush && (
            <span className="text-slate-400">
              · {t("lastPush", { ago: timeAgo(status.data.lastPush) })} · {t("totalPushes", { count: status.data.pushCount })}
            </span>
          )}
          {publicUrl && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-blue-600 hover:underline flex items-center gap-1"
            >
              {t("viewLive")}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      )}

      {/* Error */}
      {status.data?.lastError && (
        <div className="mb-3 p-2 bg-red-50 border border-red-100 rounded text-xs text-red-600">
          {status.data.lastError}
        </div>
      )}

      {/* Form */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className="block text-xs text-slate-500 mb-1">{t("pushInterval")}</label>
          <select
            value={intervalSeconds ?? 30}
            onChange={(e) => setIntervalSeconds(parseInt(e.target.value, 10))}
            disabled={running || isBusy}
            className="w-full border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value={10}>{t("seconds", { count: 10 })}</option>
            <option value={15}>{t("seconds", { count: 15 })}</option>
            <option value={30}>{t("seconds", { count: 30 })}</option>
            <option value={60}>{t("seconds", { count: 60 })}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">{t("country")}</label>
          <select
            value={country ?? "SE"}
            onChange={(e) => setCountry(e.target.value)}
            disabled={isBusy}
            className="w-full border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 disabled:bg-slate-50"
          >
            <option value="SE">{t("sweden")}</option>
            <option value="NO">{t("norway")}</option>
            <option value="FI">{t("finland")}</option>
            <option value="DK">{t("denmark")}</option>
            <option value="CH">{t("switzerland")}</option>
            <option value="AT">{t("austria")}</option>
            <option value="DE">{t("germany")}</option>
            <option value="GB">{t("unitedKingdom")}</option>
            <option value="CZ">{t("czechRepublic")}</option>
            <option value="FR">{t("france")}</option>
            <option value="IT">{t("italy")}</option>
            <option value="SK">{t("slovakia")}</option>
          </select>
        </div>
      </div>

      {/* Bottom row: public checkbox + action buttons */}
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPublic ?? false}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={isBusy}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          {t("publicCompetition")}
        </label>

        <div className="ml-auto flex items-center gap-2">
          {!running && (
            <button
              onClick={() =>
                saveMut.mutate({
                  intervalSeconds: intervalSeconds ?? 30,
                  country: country ?? "SE",
                  isPublic: isPublic ?? false,
                })
              }
              disabled={isBusy}
              className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
            >
              {t("save")}
            </button>
          )}
          {tavid && (
            <button
              onClick={() => pushNowMut.mutate()}
              disabled={isBusy}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-md disabled:opacity-50 transition-colors"
            >
              {pushNowMut.isPending ? (
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              {t("pushNow")}
            </button>
          )}
        </div>
      </div>

      {/* Push result */}
      {pushNowMut.isSuccess && pushNowMut.data && (
        <div className="mt-2 text-xs text-emerald-600">
          {t("pushedStats", { runners: pushNowMut.data.stats.runners, results: pushNowMut.data.stats.results, splitcontrols: pushNowMut.data.stats.splitcontrols })}
        </div>
      )}

      {/* Enable error */}
      {(enableMut.isError || disableMut.isError) && (
        <div className="mt-2 text-xs text-red-600">
          {enableMut.error?.message ?? disableMut.error?.message}
        </div>
      )}

      {/* First-time help */}
      {!tavid && !running && (
        <p className="mt-2 text-xs text-slate-400">
          {t("liveresultsHelp")}
        </p>
      )}
    </div>
  );
}
// ─── Club Sync Panel ────────────────────────────────────────

// ─── Registration & Payment Settings ────────────────────────

const ALL_PAYMENT_METHODS = [
  { key: "billed", labelKey: "paymentInvoice" },
  { key: "on-site", labelKey: "paymentOnSite" },
  { key: "card", labelKey: "paymentCard" },
  { key: "swish", labelKey: "paymentSwish" },
  { key: "cash", labelKey: "paymentCash" },
] as const;

type MethodItem = { key: string; enabled: boolean };

function buildOrderedList(enabledKeys: string[]): MethodItem[] {
  const items: MethodItem[] = enabledKeys.map((key) => ({ key, enabled: true }));
  for (const { key } of ALL_PAYMENT_METHODS) {
    if (!enabledKeys.includes(key)) items.push({ key, enabled: false });
  }
  return items;
}

function RegistrationPaymentSettings() {
  const { t } = useTranslation("event");
  const config = trpc.competition.getRegistrationConfig.useQuery();
  const updateConfig = trpc.competition.setRegistrationConfig.useMutation({
    onSuccess: () => config.refetch(),
  });
  const cardFeeQuery = trpc.competition.getCardFee.useQuery();
  const setCardFee = trpc.competition.setCardFee.useMutation({
    onSuccess: () => cardFeeQuery.refetch(),
  });
  const [cardFeeInput, setCardFeeInput] = useState("");

  const [items, setItems] = useState<MethodItem[]>([]);
  const [swishNumber, setSwishNumber] = useState("");
  const initialized = useRef(false);
  const cardFeeInitialized = useRef(false);

  useEffect(() => {
    if (!config.data || initialized.current) return;
    initialized.current = true;
    setItems(buildOrderedList(config.data.paymentMethods));
    setSwishNumber(config.data.swishNumber);
  }, [config.data]);

  useEffect(() => {
    if (cardFeeQuery.data === undefined || cardFeeInitialized.current) return;
    cardFeeInitialized.current = true;
    setCardFeeInput(String(cardFeeQuery.data.cardFee));
  }, [cardFeeQuery.data]);

  const save = (patch: Parameters<typeof updateConfig.mutate>[0]) => {
    updateConfig.mutate(patch);
  };

  const saveItems = (next: MethodItem[]) => {
    setItems(next);
    save({ paymentMethods: next.filter((m) => m.enabled).map((m) => m.key) });
  };

  const toggleMethod = (key: string) => {
    const next = items.map((m) => m.key === key ? { ...m, enabled: !m.enabled } : m);
    saveItems(next);
  };

  const moveItem = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    saveItems(next);
  };

  const labelMap = Object.fromEntries(ALL_PAYMENT_METHODS.map(({ key, labelKey }) => [key, labelKey]));
  const firstEnabled = items.find((m) => m.enabled)?.key;

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
        {t("registrationSettings")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">
            {t("paymentMethods")}
          </label>
          <div className="space-y-1">
            {items.map((item, idx) => (
              <div
                key={item.key}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                  item.enabled
                    ? "bg-blue-50/50 border-blue-200"
                    : "border-slate-100 bg-slate-50/50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => moveItem(idx, -1)}
                  disabled={idx === 0}
                  className="text-slate-400 hover:text-slate-600 disabled:opacity-20 cursor-pointer disabled:cursor-default text-xs leading-none"
                  aria-label="Move up"
                >▲</button>
                <button
                  type="button"
                  onClick={() => moveItem(idx, 1)}
                  disabled={idx === items.length - 1}
                  className="text-slate-400 hover:text-slate-600 disabled:opacity-20 cursor-pointer disabled:cursor-default text-xs leading-none"
                  aria-label="Move down"
                >▼</button>
                <label className="flex items-center gap-2 flex-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={() => toggleMethod(item.key)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span className={`text-sm ${item.enabled ? "text-slate-700 font-medium" : "text-slate-400"}`}>
                    {t(labelMap[item.key] ?? item.key)}
                  </span>
                </label>
                {item.key === firstEnabled && (
                  <span className="text-xs text-blue-500 font-medium">{t("defaultMethod")}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {items.some((m) => m.key === "swish" && m.enabled) && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t("swishNumber")}
            </label>
            <input
              type="text"
              value={swishNumber}
              onChange={(e) => setSwishNumber(e.target.value)}
              onBlur={() => save({ swishNumber })}
              placeholder={t("swishNumberPlaceholder")}
              className="w-full max-w-xs px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-400 mt-1">
              {t("swishPaymentMessage")}
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {t("rentalCardFee")}
          </label>
          <input
            type="number"
            min={0}
            value={cardFeeInput}
            onChange={(e) => setCardFeeInput(e.target.value)}
            onBlur={() => {
              const val = parseInt(cardFeeInput, 10);
              if (!isNaN(val) && val >= 0) setCardFee.mutate({ cardFee: val });
            }}
            data-testid="rental-card-fee-input"
            className="w-28 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-400 mt-1">
            {t("rentalCardFeeHelp")}
          </p>
        </div>
      </div>
    </div>
  );
}

function ReceiptSettings() {
  const { t } = useTranslation("event");
  const config = trpc.competition.getRegistrationConfig.useQuery();
  const updateConfig = trpc.competition.setRegistrationConfig.useMutation({
    onSuccess: () => config.refetch(),
  });

  const [orgNumber, setOrgNumber] = useState("");
  const [vatExempt, setVatExempt] = useState(true);
  const [friskvardNote, setFriskvardNote] = useState(false);
  const [printReceipt, setPrintReceipt] = useState(false);
  const [regReceiptMsg, setRegReceiptMsg] = useState("");
  const [finishReceiptMsg, setFinishReceiptMsg] = useState("");
  const initialized = useRef(false);

  useEffect(() => {
    if (!config.data || initialized.current) return;
    initialized.current = true;
    setOrgNumber(config.data.orgNumber);
    setVatExempt(config.data.vatExempt);
    setFriskvardNote(config.data.receiptFriskvardNote);
    setPrintReceipt(config.data.printRegistrationReceipt);
    setRegReceiptMsg(config.data.registrationReceiptMessage);
    setFinishReceiptMsg(config.data.finishReceiptMessage);
  }, [config.data]);

  const save = (patch: Parameters<typeof updateConfig.mutate>[0]) => {
    updateConfig.mutate(patch);
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
        {t("receiptSettings")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {t("orgNumber")}
          </label>
          <input
            type="text"
            value={orgNumber}
            onChange={(e) => setOrgNumber(e.target.value)}
            onBlur={() => save({ orgNumber })}
            placeholder={t("orgNumberPlaceholder")}
            className="w-full max-w-xs px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-400 mt-1">
            {t("orgNumberHelp")}
          </p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={vatExempt}
            onChange={(e) => {
              setVatExempt(e.target.checked);
              save({ vatExempt: e.target.checked });
            }}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-slate-700">{t("vatExempt")}</span>
        </label>

        {orgNumber && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={friskvardNote}
              onChange={(e) => {
                setFriskvardNote(e.target.checked);
                save({ receiptFriskvardNote: e.target.checked });
              }}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-slate-700">{t("friskvardNote")}</span>
          </label>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={printReceipt}
            onChange={(e) => {
              setPrintReceipt(e.target.checked);
              save({ printRegistrationReceipt: e.target.checked });
            }}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-slate-700">{t("printRegistrationReceipt")}</span>
        </label>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {t("registrationReceiptMessage")} <span className="text-slate-400 font-normal">({t("registrationReceiptMessageOptional")})</span>
          </label>
          <textarea
            value={regReceiptMsg}
            onChange={(e) => setRegReceiptMsg(e.target.value)}
            onBlur={() => save({ registrationReceiptMessage: regReceiptMsg })}
            placeholder={t("registrationReceiptPlaceholder")}
            rows={2}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {t("finishReceiptMessage")} <span className="text-slate-400 font-normal">({t("finishReceiptMessageOptional")})</span>
          </label>
          <textarea
            value={finishReceiptMsg}
            onChange={(e) => setFinishReceiptMsg(e.target.value)}
            onBlur={() => save({ finishReceiptMessage: finishReceiptMsg })}
            placeholder={t("finishReceiptPlaceholder")}
            rows={2}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Club Sync ──────────────────────────────────────────────

function ClubSyncPanel({ env }: { env?: string }) {
  const { t } = useTranslation("event");
  const syncStatus = trpc.eventor.syncStatus.useQuery();
  const syncMutation = trpc.eventor.syncClubs.useMutation();

  if (!syncStatus.data?.apiKeyConfigured) return null;

  return (
    <div className="bg-emerald-50 rounded-xl border border-emerald-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {t("clubSync")}
            </div>
            <div className="text-xs text-slate-500">
              {t("clubSyncDescription")}
            </div>
          </div>
        </div>

        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2"
        >
          {syncMutation.isPending ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {t("syncing")}
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t("syncClubs")}
            </>
          )}
        </button>
      </div>

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-emerald-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">{t("syncComplete")}</span>{" "}
          {t("clubSyncComplete", { added: syncMutation.data.added, updated: syncMutation.data.updated, total: syncMutation.data.total })}
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          {t("syncFailed", { message: syncMutation.error.message })}
        </div>
      )}
    </div>
  );
}

// ─── Google Sheets Backup ────────────────────────────────────

const APPS_SCRIPT_TEMPLATE = `function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = JSON.parse(e.postData.contents);
  var sheetName = data.sheet || "Readouts";
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  if (sheetName === "Registrations") {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp","RunnerId","Name","Class","Club","CardNo",
        "StartNo","BirthYear","Sex","Nationality","Phone","Fee","Paid","PayMode"]);
    }
    sheet.appendRow([data.timestamp, data.runnerId, data.name, data.className,
      data.clubName, data.cardNo, data.startNo, data.birthYear, data.sex,
      data.nationality, data.phone, data.fee, data.paid, data.payMode]);
  } else {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp","CardNo","CardType","Runner","Class","Club",
        "StartNo","CheckTime","StartTime","FinishTime","PunchCount","Punches",
        "PunchesRelevant","BatteryVoltage"]);
    }
    sheet.appendRow([data.timestamp, data.cardNo, data.cardType, data.runnerName,
      data.className, data.clubName, data.startNo, data.checkTime, data.startTime,
      data.finishTime, data.punchCount, data.punches, data.punchesRelevant,
      data.batteryVoltage]);
  }

  return ContentService.createTextOutput('{"status":"ok"}')
    .setMimeType(ContentService.MimeType.JSON);
}`;

function GoogleSheetsBackup() {
  const { t } = useTranslation("event");
  const config = trpc.competition.getGoogleSheetsConfig.useQuery();
  const setConfig = trpc.competition.setGoogleSheetsConfig.useMutation({
    onSuccess: () => config.refetch(),
  });
  const testWebhook = trpc.competition.testGoogleSheetsWebhook.useMutation();

  const [url, setUrl] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!config.data || initialized.current) return;
    initialized.current = true;
    setUrl(config.data.webhookUrl);
  }, [config.data]);

  const handleSave = () => {
    setConfig.mutate({ webhookUrl: url }, {
      onSuccess: () => {
        setSaveLabel(t("saved"));
        setTimeout(() => setSaveLabel(null), 2000);
      },
    });
  };

  const handleTest = () => {
    if (!url) return;
    testWebhook.mutate({ webhookUrl: url });
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(APPS_SCRIPT_TEMPLATE);
    setCopyLabel(t("copied"));
    setTimeout(() => setCopyLabel(null), 2000);
  };

  const isConfigured = !!config.data?.webhookUrl;

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
        {t("googleSheetsBackup")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-900">
              {t("googleSheetsBackup")}
            </div>
            <div className="text-xs text-slate-500">
              {t("googleSheetsDescription")}
            </div>
          </div>
          {isConfigured && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Active
            </span>
          )}
        </div>

        {/* URL input + buttons */}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {t("webhookUrl")}
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("webhookUrlPlaceholder")}
              className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSave}
              disabled={setConfig.isPending}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {saveLabel ?? t("save")}
            </button>
            <button
              onClick={handleTest}
              disabled={!url || testWebhook.isPending}
              className="px-3 py-1.5 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {testWebhook.isPending ? t("testing") : t("testConnection")}
            </button>
          </div>
        </div>

        {/* Test result */}
        {testWebhook.isSuccess && testWebhook.data.ok && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-100 text-xs text-green-700">
            {t("testSuccess")}
          </div>
        )}
        {testWebhook.isSuccess && !testWebhook.data.ok && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
            {t("testFailed", { message: testWebhook.data.error || `HTTP ${testWebhook.data.status}` })}
          </div>
        )}
        {testWebhook.isError && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
            {t("testFailed", { message: testWebhook.error.message })}
          </div>
        )}

        {/* Setup instructions */}
        <button
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-xs text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
        >
          {showInstructions ? "▾" : "▸"} {t("setupInstructions")}
        </button>

        {showInstructions && (
          <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-2 text-xs text-slate-600">
            <p>{t("setupStep1")}</p>
            <p>{t("setupStep2")}</p>
            <p>{t("setupStep3")}</p>
            <p>{t("setupStep4")}</p>
            <p>{t("setupStep5")}</p>
            <p>{t("setupStep6")}</p>

            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-slate-700">Apps Script:</span>
                <button
                  onClick={handleCopy}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
                >
                  {copyLabel ?? t("copyScript")}
                </button>
              </div>
              <pre className="p-3 bg-white rounded border border-slate-200 text-[11px] text-slate-700 overflow-x-auto whitespace-pre-wrap">
                {APPS_SCRIPT_TEMPLATE}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Livelox Section ─────────────────────────────────────────

function LiveloxSection({ eventorEventId }: { eventorEventId: number | null | undefined }) {
  const utils = trpc.useUtils();
  const storedEventId = trpc.competition.getLiveloxEventId.useQuery();
  const setEventId = trpc.competition.setLiveloxEventId.useMutation({
    onSuccess: () => storedEventId.refetch(),
  });
  const syncedClasses = trpc.livelox.listSyncedClasses.useQuery();
  const syncMutation = trpc.livelox.sync.useMutation({
    onSuccess: () => {
      syncedClasses.refetch();
      utils.livelox.listRoutes.invalidate();
    },
  });
  const [eventIdInput, setEventIdInput] = useState("");
  const [syncResult, setSyncResult] = useState<{
    classesSynced: number;
    routesSynced: number;
    unmatched: { runners: string[]; classes: string[] };
  } | null>(null);
  const [detectState, setDetectState] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "success"; eventName: string; liveloxEventId: number }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const initialized = useRef(false);

  useEffect(() => {
    if (storedEventId.data == null || initialized.current) return;
    initialized.current = true;
    if (storedEventId.data.liveloxEventId != null) {
      setEventIdInput(String(storedEventId.data.liveloxEventId));
    }
  }, [storedEventId.data]);

  const handleSaveEventId = useCallback(() => {
    const id = parseInt(eventIdInput, 10);
    setEventId.mutate({ liveloxEventId: isNaN(id) ? null : id });
  }, [eventIdInput, setEventId]);

  const handleAutoDetect = useCallback(async () => {
    if (!eventorEventId) return;
    setDetectState({ status: "pending" });
    try {
      const data = await utils.eventor.getLiveloxClasses.fetch({ eventorEventId });
      setEventIdInput(String(data.liveloxEventId));
      setEventId.mutate({ liveloxEventId: data.liveloxEventId });
      setDetectState({ status: "success", eventName: data.eventName, liveloxEventId: data.liveloxEventId });
    } catch (err) {
      setDetectState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [eventorEventId, utils, setEventId]);

  const handleSync = useCallback(() => {
    const id = parseInt(eventIdInput, 10);
    if (isNaN(id)) return;
    setSyncResult(null);
    syncMutation.mutate(
      { liveloxEventId: id },
      { onSuccess: (data) => setSyncResult(data) },
    );
  }, [eventIdInput, syncMutation]);

  const totalRoutes = useMemo(
    () => syncedClasses.data?.reduce((s, c) => s + c.routeCount, 0) ?? 0,
    [syncedClasses.data],
  );
  const lastSync = useMemo(() => {
    if (!syncedClasses.data?.length) return null;
    return syncedClasses.data.reduce<Date | null>((latest, c) => {
      const d = new Date(c.syncedAt);
      return latest == null || d > latest ? d : latest;
    }, null);
  }, [syncedClasses.data]);

  const hasValidId = !isNaN(parseInt(eventIdInput, 10));

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
        Livelox
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-1.447-.894L15 9m0 8V9m0 0L9 7" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-900">GPS Routes</div>
            <div className="text-xs text-slate-500">Sync GPS route data from Livelox into O2</div>
          </div>
          {syncedClasses.data && syncedClasses.data.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
              {syncedClasses.data.length} classes · {totalRoutes} routes
            </span>
          )}
        </div>

        {/* Event ID input */}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Livelox Event ID
          </label>
          <div className="flex gap-2 flex-wrap">
            <input
              type="number"
              value={eventIdInput}
              onChange={(e) => setEventIdInput(e.target.value)}
              placeholder="e.g. 182866"
              className="flex-1 min-w-0 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
            />
            <button
              onClick={handleSaveEventId}
              disabled={setEventId.isPending}
              className="px-3 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              Save
            </button>
            {eventorEventId && (
              <button
                onClick={() => void handleAutoDetect()}
                disabled={detectState.status === "pending"}
                className="px-3 py-1.5 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {detectState.status === "pending" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 border-2 border-slate-400 border-t-slate-700 rounded-full animate-spin" />
                    Detecting…
                  </span>
                ) : (
                  "Auto-detect from Eventor"
                )}
              </button>
            )}
          </div>
          {detectState.status === "error" && (
            <p className="mt-1 text-xs text-red-600">
              Could not detect Livelox event: {detectState.message}
            </p>
          )}
          {detectState.status === "success" && (
            <p className="mt-1 text-xs text-green-700">
              Detected: {detectState.eventName} (ID {detectState.liveloxEventId})
            </p>
          )}
        </div>

        {/* Stats */}
        {syncedClasses.data && syncedClasses.data.length > 0 && (
          <div className="text-xs text-slate-500">
            {syncedClasses.data.length} classes · {totalRoutes} routes
            {lastSync && <span> · last synced {formatDateTime(lastSync)}</span>}
          </div>
        )}

        {/* Sync button */}
        <div>
          <button
            onClick={handleSync}
            disabled={!hasValidId || syncMutation.isPending}
            className="px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2"
          >
            {syncMutation.isPending ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync all classes
              </>
            )}
          </button>
        </div>

        {/* Sync result */}
        {syncResult && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-100 text-xs text-green-700 space-y-1">
            <p className="font-medium">
              Sync complete: {syncResult.classesSynced} classes, {syncResult.routesSynced} routes
            </p>
            {syncResult.unmatched.runners.length > 0 && (
              <p className="text-amber-700">
                Unmatched runners:{" "}
                {syncResult.unmatched.runners.slice(0, 5).join(", ")}
                {syncResult.unmatched.runners.length > 5 &&
                  ` +${syncResult.unmatched.runners.length - 5} more`}
              </p>
            )}
            {syncResult.unmatched.classes.length > 0 && (
              <p className="text-amber-700">
                Unmatched classes: {syncResult.unmatched.classes.join(", ")}
              </p>
            )}
          </div>
        )}
        {syncMutation.isError && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
            Sync failed: {syncMutation.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

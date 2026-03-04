import { useState, useEffect } from "react";
import { trpc } from "../lib/trpc";
import { formatDateTime, timeAgo } from "../lib/format";
import { ClubLogo } from "../components/ClubLogo";

export function EventPage() {
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
          Competition Info
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
                <span>Database: <span className="font-mono">{d.competition.nameId}</span></span>
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
          Data Sync
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


      {/* Event Settings (future) */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Settings
        </h2>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-sm text-slate-400">
            Event settings (bib numbers, timing mode, etc.) will be available here.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sync Behavior Help ─────────────────────────────────────

function SyncBehaviorHelp() {
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
        {open ? "Hide sync details" : "How does sync work?"}
      </button>

      {open && (
        <div className="mt-2 p-3 bg-white border border-blue-100 rounded-lg space-y-3 text-xs text-slate-700">
          <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">What gets synced from Eventor</p>

          <div className="space-y-2">
            <SyncRow icon="👤" label="Runners" detail="Names, club, class, birth year, sex, nationality, SI card" />
            <SyncRow icon="💳" label="Fees" detail="Entry fee, paid amount, and taxable portion from AssignedFee — not overwritten if manually edited" />
            <SyncRow icon="🏷️" label="Bib" detail="Bib number string (e.g. H4 or 123) from results — stored separately from the integer start number" />
            <SyncRow icon="🏅" label="Ranking score" detail="Pre-race ranking score from Eventor entry — stored as initial Rank value" />
            <SyncRow icon="⏱️" label="Results" detail="Start time, finish time, and status (OK / DNS / DNF / DSQ etc.) when results are published" />
            <SyncRow icon="🔵" label="Classes & clubs" detail="Names, age limits, sort order, club contact info" />
          </div>

          <div className="border-t border-slate-100 pt-2 space-y-2">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">Special status handling</p>
            <SyncRow icon="🚫" label="Withdrawn (Återbud)" detail="Runners who disappear from Eventor and have no race result are automatically marked as Cancelled (status 21), matching MeOS's StatusCANCEL" />
            <SyncRow icon="🔇" label="NoTiming" detail="Classes with TimePresentation=false in Eventor are imported with StatusNoTiming — they appear in start lists but results are not timed" />
          </div>

          <div className="border-t border-slate-100 pt-2 space-y-2">
            <p className="text-[11px] text-slate-500 uppercase tracking-wide font-medium">What is NOT synced</p>
            <SyncRow icon="🌊" label="Start groups / waves" detail="StartTimeAllocationRequest (heat/wave assignments) is not yet imported — deferred for future implementation" />
            <SyncRow icon="🏃" label="Split times" detail="Intermediate punch splits from Eventor results are not imported — splits are read live from SI cards instead" />
          </div>

          <p className="text-[10px] text-slate-400 border-t border-slate-100 pt-2">
            Sync is one-way pull: OOS reads data from Eventor, never writes back automatically. Only Results and Start List can be pushed to Eventor via the buttons above. Fees, registrations, and class setup remain authoritative in Eventor. Sync is incremental — existing runners are updated in place. EntrySource is set to the Eventor event ID so the database is compatible with MeOS.
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
              Eventor Linked
              <span className="ml-2 text-xs font-normal text-slate-500">
                Event #{eventorEventId}
              </span>
              {env === "test" && (
                <span className="ml-2 px-1 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase">
                  Test-Eventor
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500">
              Last sync:{" "}
              {lastSync
                ? <>{formatDateTime(lastSync)} <span className="text-slate-400">({timeAgo(lastSync)})</span></>
                : "Never"}
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
                Syncing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync from Eventor
              </>
            )}
          </button>

          {env === "test" && (
            <>
              <button
                onClick={() => pushStartListMutation.mutate()}
                disabled={pushStartListMutation.isPending || !apiKeyConfigured}
                className="px-4 py-2 bg-slate-600 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap"
              >
                {pushStartListMutation.isPending ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Pushing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Push Start List
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
                    Pushing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Push Results
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-blue-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">Sync complete:</span>{" "}
          {syncMutation.data.runnersAdded > 0 && <span>{syncMutation.data.runnersAdded} runners added, </span>}
          {syncMutation.data.runnersUpdated > 0 && <span>{syncMutation.data.runnersUpdated} runners updated, </span>}
          {syncMutation.data.cancelledCount > 0 && <span className="text-amber-700">{syncMutation.data.cancelledCount} marked as withdrawn, </span>}
          {syncMutation.data.classesAdded > 0 && <span>{syncMutation.data.classesAdded} classes added, </span>}
          {syncMutation.data.classesUpdated > 0 && <span>{syncMutation.data.classesUpdated} classes updated, </span>}
          {syncMutation.data.clubsAdded > 0 && <span>{syncMutation.data.clubsAdded} clubs added, </span>}
          {syncMutation.data.clubsUpdated > 0 && <span>{syncMutation.data.clubsUpdated} clubs updated, </span>}
          {syncMutation.data.runnersAdded === 0 &&
            syncMutation.data.runnersUpdated === 0 &&
            syncMutation.data.cancelledCount === 0 &&
            syncMutation.data.classesAdded === 0 &&
            syncMutation.data.clubsAdded === 0 && <span>Everything up to date</span>}
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          Sync failed: {syncMutation.error.message}
        </div>
      )}

      {pushStartListMutation.isSuccess && pushStartListMutation.data && (
        <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700">
          <span className="font-medium">Push complete:</span> Uploaded start list for {pushStartListMutation.data.runnerCount} runners to Test-Eventor.
        </div>
      )}

      {pushStartListMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          Push start list failed: {pushStartListMutation.error.message}
        </div>
      )}

      {pushResultsMutation.isSuccess && pushResultsMutation.data && (
        <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800">
          <span className="font-medium">Push complete:</span> Uploaded results for {pushResultsMutation.data.runnerCount} runners to Test-Eventor.
        </div>
      )}

      {pushResultsMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          Push results failed: {pushResultsMutation.error.message}
        </div>
      )}

      {!apiKeyConfigured && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 p-2 rounded-lg">
          Eventor API key not configured. Go to the competition selector and connect your key to enable sync.
        </div>
      )}
    </div>
  );
}

// ─── Runner Database Panel ──────────────────────────────────

function RunnerDbPanel({ env }: { env?: string }) {
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
              Runner Database
              <span className="ml-2 text-xs font-normal text-slate-500">
                Global
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {dbStatus.data?.runnerCount
                ? (
                  <>
                    {dbStatus.data.runnerCount.toLocaleString()} runners,{" "}
                    {dbStatus.data.clubCount.toLocaleString()} clubs
                    {dbStatus.data.lastSync && (
                      <span className="text-slate-400">
                        {" "}— synced {timeAgo(dbStatus.data.lastSync)}
                      </span>
                    )}
                  </>
                )
                : "Not synced yet"}
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
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {dbStatus.data?.runnerCount ? "Re-sync" : "Download"}
            </>
          )}
        </button>
      </div>

      {syncMutation.isPending && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-purple-100 text-xs text-slate-600 flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
          Downloading runner database from Eventor — this may take 30-60 seconds for ~200k runners...
        </div>
      )}

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-purple-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">Sync complete:</span>{" "}
          {syncMutation.data.runners.toLocaleString()} runners,{" "}
          {syncMutation.data.clubs.toLocaleString()} clubs imported
          {syncMutation.data.logosAdded > 0 && (
            <>, {syncMutation.data.logosAdded} logos downloaded</>
          )}
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          Sync failed: {syncMutation.error.message}
        </div>
      )}
    </div>
  );
}

// ─── LiveResults Panel ────────────────────────────────────────

function LiveResultsPanel() {
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
          <span className="text-sm font-semibold text-slate-800">LiveResults</span>
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
          <span>Live</span>
          {status.data?.lastPush && (
            <span className="text-slate-400">
              · Last push {timeAgo(status.data.lastPush)} · {status.data.pushCount} total
            </span>
          )}
          {publicUrl && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-blue-600 hover:underline flex items-center gap-1"
            >
              View live
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
          <label className="block text-xs text-slate-500 mb-1">Push interval</label>
          <select
            value={intervalSeconds ?? 30}
            onChange={(e) => setIntervalSeconds(parseInt(e.target.value, 10))}
            disabled={running || isBusy}
            className="w-full border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value={10}>10 seconds</option>
            <option value={15}>15 seconds</option>
            <option value={30}>30 seconds</option>
            <option value={60}>60 seconds</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Country</label>
          <select
            value={country ?? "SE"}
            onChange={(e) => setCountry(e.target.value)}
            disabled={isBusy}
            className="w-full border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 disabled:bg-slate-50"
          >
            <option value="SE">Sweden</option>
            <option value="NO">Norway</option>
            <option value="FI">Finland</option>
            <option value="DK">Denmark</option>
            <option value="CH">Switzerland</option>
            <option value="AT">Austria</option>
            <option value="DE">Germany</option>
            <option value="GB">United Kingdom</option>
            <option value="CZ">Czech Republic</option>
            <option value="FR">France</option>
            <option value="IT">Italy</option>
            <option value="SK">Slovakia</option>
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
          Public competition
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
              Save
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
              Push now
            </button>
          )}
        </div>
      </div>

      {/* Push result */}
      {pushNowMut.isSuccess && pushNowMut.data && (
        <div className="mt-2 text-xs text-emerald-600">
          Pushed: {pushNowMut.data.stats.runners} runners, {pushNowMut.data.stats.results} results,{" "}
          {pushNowMut.data.stats.splitcontrols} split controls
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
          Toggle on to automatically create a competition on liveresultat.orientering.se and start pushing results.
          Controls with "radio" in their name will appear as split times.
        </p>
      )}
    </div>
  );
}
// ─── Club Sync Panel ────────────────────────────────────────

function ClubSyncPanel({ env }: { env?: string }) {
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
              Club Sync
            </div>
            <div className="text-xs text-slate-500">
              Sync club data and logos from Eventor
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
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Clubs
            </>
          )}
        </button>
      </div>

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-emerald-100 text-xs text-slate-600">
          <span className="font-medium text-green-700">Sync complete:</span>{" "}
          {syncMutation.data.added} added, {syncMutation.data.updated} updated
          {syncMutation.data.logosAdded > 0 && <>, {syncMutation.data.logosAdded} logos</>}
          {" "}({syncMutation.data.total} total)
        </div>
      )}

      {syncMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs text-red-600">
          Sync failed: {syncMutation.error.message}
        </div>
      )}
    </div>
  );
}

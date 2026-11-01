import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Instance-admin maintenance. Rendered as the Maintenance tab of the
 * settings page, which owns the page chrome and the admin gate.
 */
export function MaintenancePanel() {
  const { t } = useTranslation("event");
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const purge = trpc.competition.purgeDeleted.useMutation({
    onSuccess: () => {
      void utils.competition.list.invalidate();
      setConfirming(false);
    },
  });

  return (
    <div data-testid="maintenance-panel">
      <p className="text-sm text-slate-600 mb-4">{t("maintenanceHelp")}</p>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-800">
          {t("cleanUpDeleted")}
        </h2>
        <p className="text-xs text-slate-500 mt-1 mb-4">{t("cleanUpTitle")}</p>

        {confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-slate-600">{t("purgeConfirm")}</span>
            <button
              type="button"
              data-testid="purge-confirm"
              onClick={() => purge.mutate()}
              disabled={purge.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
            >
              {purge.isPending ? t("purging") : t("yesPurge")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={purge.isPending}
              className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 cursor-pointer"
            >
              {t("cancel", { ns: "common" })}
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="purge-button"
            onClick={() => setConfirming(true)}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            {t("cleanUpDeleted")}
          </button>
        )}

        {purge.isSuccess && purge.data && (
          <p
            data-testid="purge-result"
            className="mt-3 text-sm text-emerald-600"
          >
            {purge.data.purged === 0
              ? t("noDeletedRecords")
              : t("purgedRecords", { count: purge.data.purged })}
          </p>
        )}
        {purge.isError && (
          <p className="mt-3 text-sm text-red-600">{purge.error.message}</p>
        )}
      </div>

      <MapBackfillCard />
      <StructureBackfillCard />
    </div>
  );
}

/**
 * Import of pre-pipeline maps into the document store
 * (docs/map-storage.md §6.7). Polls while a run is in progress.
 */
function MapBackfillCard() {
  const { t } = useTranslation("event");
  const utils = trpc.useUtils();
  const status = trpc.mapImport.backfillStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.run?.state === "running" ? 1000 : false),
  });
  const start = trpc.mapImport.backfillStart.useMutation({
    onSuccess: (data) => utils.mapImport.backfillStatus.setData(undefined, data),
  });
  const plan = status.data?.plan;
  const run = status.data?.run;
  const running = run?.state === "running";
  const pending = (plan?.clubRows ?? 0) + (plan?.eventRows ?? 0);

  return (
    <div
      data-testid="map-backfill-card"
      className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mt-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">{t("mapBackfillTitle")}</h2>
      <p className="text-xs text-slate-500 mt-1 mb-4">{t("mapBackfillHelp")}</p>

      {plan && (
        <p data-testid="map-backfill-pending" className="text-sm text-slate-600 mb-3">
          {pending === 0
            ? t("mapBackfillNothing")
            : t("mapBackfillPending", { clubs: plan.clubRows, events: plan.eventRows })}
        </p>
      )}

      <button
        type="button"
        data-testid="map-backfill-run"
        onClick={() => start.mutate(undefined)}
        disabled={running || start.isPending || pending === 0}
        className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
      >
        {running
          ? t("mapBackfillRunning", { processed: run.processed, total: run.total })
          : t("mapBackfillRun")}
      </button>

      {running && run.current && (
        <p className="mt-2 text-xs text-slate-500">{t("mapBackfillCurrent", { name: run.current.name })}</p>
      )}
      {run && run.state !== "running" && (
        <p
          data-testid="map-backfill-result"
          className={`mt-3 text-sm ${run.failed > 0 || run.state === "failed" ? "text-red-600" : "text-emerald-600"}`}
        >
          {run.state === "failed"
            ? t("mapBackfillAborted", { error: run.error ?? "" })
            : t("mapBackfillDone", { done: run.done, failed: run.failed, total: run.total })}
        </p>
      )}
      {run && run.failures.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold text-slate-600">{t("mapBackfillFailures")}</p>
          <ul className="text-xs text-slate-600 list-disc ml-4">
            {run.failures.map((f) => (
              <li key={`${f.kind}-${f.id}`}>
                {f.name}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(status.isError || start.isError) && (
        <p className="mt-3 text-sm text-red-600">{status.error?.message ?? start.error?.message}</p>
      )}
    </div>
  );
}

/**
 * Fills `courses.structure` where it is NULL (docs/course-layer.md §6.4);
 * the button form of `pnpm course:backfill-structure`.
 */
function StructureBackfillCard() {
  const { t } = useTranslation("event");
  const utils = trpc.useUtils();
  const status = trpc.event.structureBackfillStatus.useQuery();
  const start = trpc.event.structureBackfillStart.useMutation({
    onSuccess: () => utils.event.structureBackfillStatus.invalidate(),
  });
  const pending = status.data?.pending ?? 0;
  const result = start.data;

  return (
    <div
      data-testid="structure-backfill-card"
      className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mt-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">{t("structureBackfillTitle")}</h2>
      <p className="text-xs text-slate-500 mt-1 mb-4">{t("structureBackfillHelp")}</p>

      {status.data && (
        <p data-testid="structure-backfill-pending" className="text-sm text-slate-600 mb-3">
          {pending === 0 ? t("structureBackfillNothing") : t("structureBackfillPending", { count: pending })}
        </p>
      )}

      <button
        type="button"
        data-testid="structure-backfill-run"
        onClick={() => start.mutate()}
        disabled={start.isPending || pending === 0}
        className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
      >
        {t("structureBackfillRun")}
      </button>

      {result && (
        <p
          data-testid="structure-backfill-result"
          className={`mt-3 text-sm ${result.failed > 0 ? "text-red-600" : "text-emerald-600"}`}
        >
          {t("structureBackfillDone", { filled: result.filled, failed: result.failed, total: result.total })}
        </p>
      )}
      {result && result.failures.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold text-slate-600">{t("structureBackfillFailures")}</p>
          <ul className="text-xs text-slate-600 list-disc ml-4">
            {result.failures.map((f) => (
              <li key={`${f.event}-${f.name}`}>
                {f.name}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(status.isError || start.isError) && (
        <p className="mt-3 text-sm text-red-600">{status.error?.message ?? start.error?.message}</p>
      )}
    </div>
  );
}

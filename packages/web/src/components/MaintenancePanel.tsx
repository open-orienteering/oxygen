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
    </div>
  );
}

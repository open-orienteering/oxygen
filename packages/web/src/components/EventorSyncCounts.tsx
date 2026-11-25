import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@oxygen/api";

export type EventorSyncResult = inferRouterOutputs<AppRouter>["eventor"]["sync"];

/** The counts of a sync preview or result, with the names behind the two that need a look. */
export function SyncCounts({
  result,
  title,
  testId,
  done = false,
  children,
}: {
  result: EventorSyncResult;
  title: string;
  testId: string;
  done?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation("event");
  const r = result.runners;
  const lines: Array<{ key: string; text: string; warn?: boolean }> = [];
  const add = (key: string, count: number, text: string, warn = false) => {
    if (count > 0) lines.push({ key, text, warn });
  };
  add("runnersAdded", r.added, t("runnersAdded", { count: r.added }));
  add("runnersUpdated", r.updated, t("runnersUpdated", { count: r.updated }));
  add("reinstated", r.reinstated, t("syncReinstated", { count: r.reinstated }));
  add("wouldCancel", r.wouldCancel, t(done ? "cancelledCount" : "syncWouldCancel", { count: r.wouldCancel }), true);
  add("heldBack", r.heldBack, t("syncHeldBack", { count: r.heldBack }), true);
  add("keptLocal", r.keptLocal, t("syncKeptLocal", { count: r.keptLocal }));
  add("classBlocked", r.classChangeBlocked, t("syncClassBlocked", { count: r.classChangeBlocked }));
  add("cardConflicts", r.cardConflicts, t("syncCardConflicts", { count: r.cardConflicts }));
  add("duplicateEntries", r.duplicateEntries, t("syncDuplicateEntries", { count: r.duplicateEntries }));
  add("skippedNoId", r.skippedNoId, t("syncSkippedNoId", { count: r.skippedNoId }), true);
  add("classesAdded", result.classes.added, t("classesAdded", { count: result.classes.added }));
  add("classesUpdated", result.classes.updated, t("classesUpdated", { count: result.classes.updated }));
  add("classesKept", result.classes.keptLocal, t("syncClassesKept", { count: result.classes.keptLocal }));
  add("clubsAdded", result.clubs.added, t("clubsAdded", { count: result.clubs.added }));
  add("clubsUpdated", result.clubs.updated, t("clubsUpdated", { count: result.clubs.updated }));
  return (
    <div data-testid={testId} className="mt-3 p-3 bg-white rounded-lg border border-blue-100 text-xs text-slate-600">
      <div className="font-medium text-green-700 mb-1">{title}</div>
      {lines.length === 0 ? (
        <div>{t("everythingUpToDate")}</div>
      ) : (
        <ul className="space-y-0.5">
          {lines.map((l) => (
            <li key={l.key} className={l.warn ? "text-amber-700" : undefined}>{l.text}</li>
          ))}
        </ul>
      )}
      {result.samples.wouldCancel.length > 0 && (
        <div className="mt-2 text-amber-700">
          {t(done ? "syncCancelledNames" : "syncWouldCancelNames", { names: result.samples.wouldCancel.join("; ") })}
        </div>
      )}
      {result.samples.heldBack.length > 0 && (
        <div className="mt-1 text-amber-700">
          {t("syncHeldBackNames", { names: result.samples.heldBack.join("; ") })}
        </div>
      )}
      {result.classes.detailsIncomplete && (
        <div className="mt-2 text-slate-500">{t("syncDetailsIncomplete")}</div>
      )}
      {children}
    </div>
  );
}

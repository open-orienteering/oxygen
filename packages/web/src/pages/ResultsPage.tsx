import { useMemo, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import {
  formatRunningTime,
  RunnerStatus,
  type ResultEntry,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { StatusBadge } from "../components/StatusBadge";
import { RunnerInlineDetail } from "../components/RunnerInlineDetail";
import { ClubLogo } from "../components/ClubLogo";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createResultAnchors } from "../lib/structured-search/anchors/result-anchors";

const FREE_TEXT_FIELDS: (keyof ResultEntry)[] = ["name", "clubName", "className", "startNo"];

export function ResultsPage() {
  const { t } = useTranslation("results");
  const [expandedRunner, setExpandedRunner] = useNumericSearchParam("runner");

  const anchors = useMemo(() => createResultAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<ResultEntry>(
    anchors,
    FREE_TEXT_FIELDS,
  );

  const results = trpc.lists.resultList.useQuery();
  const dashboard = trpc.competition.dashboard.useQuery();
  const clubs = trpc.competition.clubs.useQuery();

  const entries = results.data ?? [];
  const COL_COUNT = 6;

  const filtered = useMemo(() => filterItems(entries), [entries, filterItems]);

  const suggestionData = useMemo(
    () => ({
      classes: dashboard.data?.classes.map((c) => ({ id: c.id, name: c.name })) ?? [],
      clubs: clubs.data?.map((c) => ({ id: c.id, name: c.name })) ?? [],
      runners: entries.map((e) => ({ name: e.name })),
    }),
    [dashboard.data, clubs.data, entries],
  );

  type Entry = (typeof filtered)[number];
  const comparators = useMemo(() => ({
    place: (a: Entry, b: Entry) => (a.place || Infinity) - (b.place || Infinity),
    name: (a: Entry, b: Entry) => a.name.localeCompare(b.name),
    club: (a: Entry, b: Entry) => a.clubName.localeCompare(b.clubName),
    time: (a: Entry, b: Entry) => (a.runningTime || Infinity) - (b.runningTime || Infinity),
    behind: (a: Entry, b: Entry) => (a.timeBehind || Infinity) - (b.timeBehind || Infinity),
    status: (a: Entry, b: Entry) => a.status - b.status,
  }), []);

  const { sorted, sort, toggle } = useSort(filtered, { key: "place", dir: "asc" }, comparators);

  // Group by class
  const grouped = new Map<string, typeof sorted>();
  for (const entry of sorted) {
    const list = grouped.get(entry.className) ?? [];
    list.push(entry);
    grouped.set(entry.className, list);
  }

  const handleRunnerClick = (id: number) => {
    setExpandedRunner(expandedRunner === id ? undefined : id);
  };

  return (
    <>
      <div className="mb-6">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchNameOrClub")}
          suggestionData={suggestionData}
        />
      </div>

      {results.isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      )}

      {tokens.length > 0 && (
        <div className="text-sm text-slate-500 mb-4">
          {t("resultCount", { count: filtered.length })}
        </div>
      )}

      {[...grouped.entries()].map(([className, classEntries]) => {
        const okCount = classEntries.filter((e) => e.status === RunnerStatus.OK).length;
        const isNoTiming = classEntries.some((e) => e.noTiming);

        return (
          <div key={className} className="mb-8">
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
                {className}
              </h3>
              {isNoTiming && (
                <span className="text-xs font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5">
                  {t("unofficial")}
                </span>
              )}
              <span className="text-xs text-slate-400">
                {t("classifiedTotal", { classified: okCount, total: classEntries.length })}
              </span>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <SortHeader label={t("place")} active={sort.key === "place"} direction={sort.dir} onClick={() => toggle("place")} className="w-14" />
                    <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                    <SortHeader label={t("club")} active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} className="hidden sm:table-cell" />
                    <SortHeader label={t("time")} active={sort.key === "time"} direction={sort.dir} onClick={() => toggle("time")} align="right" />
                    <SortHeader label={t("behind")} active={sort.key === "behind"} direction={sort.dir} onClick={() => toggle("behind")} align="right" className="hidden sm:table-cell" />
                    <SortHeader label={t("status")} active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} className="w-16" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classEntries.map((entry) => (
                    <Fragment key={entry.id}>
                      <tr
                        className={`transition-colors cursor-pointer ${expandedRunner === entry.id
                            ? "bg-blue-50"
                            : entry.place === 1
                              ? "bg-amber-50/50 hover:bg-amber-50"
                              : "hover:bg-slate-50"
                          }`}
                        onClick={() => handleRunnerClick(entry.id)}
                      >
                        <td className="px-4 py-2.5 tabular-nums">
                          {entry.place > 0 ? (
                            <span className={`font-semibold ${entry.place <= 3 ? "text-amber-700" : "text-slate-700"}`}>
                              {entry.place}
                            </span>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`font-medium ${entry.status === RunnerStatus.OK
                              ? "text-blue-700 hover:text-blue-900"
                              : "text-slate-400"
                            }`}>
                            {entry.name}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">
                          <span className="inline-flex items-center gap-1.5">
                            <ClubLogo clubId={entry.clubId} size="sm" />
                            {entry.clubName}
                          </span>
                        </td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${entry.noTiming ? "italic text-slate-400" : "font-medium text-slate-900"}`}>
                          {entry.runningTime > 0 ? formatRunningTime(entry.runningTime) : "-"}
                        </td>
                        <td className={`px-4 py-2.5 text-right tabular-nums hidden sm:table-cell ${entry.noTiming ? "italic text-slate-300" : "text-slate-500"}`}>
                          {entry.timeBehind > 0
                            ? `+${formatRunningTime(entry.timeBehind)}`
                            : entry.place === 1
                              ? ""
                              : "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={entry.status as RunnerStatusValue} />
                        </td>
                      </tr>
                      {expandedRunner === entry.id && (
                        <RunnerInlineDetail
                          key={`detail-${entry.id}`}
                          runnerId={entry.id}
                          colSpan={COL_COUNT}
                        />
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && !results.isLoading && (
        <div className="text-center py-20 text-slate-400">
          {tokens.length > 0 ? t("noMatchingResults") : t("noResultsFound")}
        </div>
      )}
    </>
  );
}

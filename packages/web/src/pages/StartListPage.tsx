import { useMemo, useState, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatMeosTime, type StartListEntry } from "@oxygen/shared";
import { RunnerInlineDetail } from "../components/RunnerInlineDetail";
import { ClubLogo } from "../components/ClubLogo";
import { SortHeader } from "../components/SortHeader";
import { DrawPanel } from "../components/DrawPanel";
import { useSort } from "../hooks/useSort";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createStartListAnchors } from "../lib/structured-search/anchors/start-list-anchors";

const FREE_TEXT_FIELDS: (keyof StartListEntry)[] = ["name", "clubName", "className", "cardNo"];

export function StartListPage() {
  const { t } = useTranslation("results");
  const [expandedRunner, setExpandedRunner] = useNumericSearchParam("runner");
  const [showDrawPanel, setShowDrawPanel] = useState(false);
  const [flatView, setFlatView] = useState(false);

  const anchors = useMemo(() => createStartListAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<StartListEntry>(
    anchors,
    FREE_TEXT_FIELDS,
  );

  const utils = trpc.useUtils();
  const startList = trpc.lists.startList.useQuery();
  const dashboard = trpc.competition.dashboard.useQuery();
  const clubs = trpc.competition.clubs.useQuery();

  const entries = startList.data ?? [];
  const COL_COUNT = flatView ? 6 : 5;

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
  const comparators = useMemo(
    () => ({
      startNo: (a: Entry, b: Entry) => a.startNo - b.startNo,
      startTime: (a: Entry, b: Entry) => a.startTime - b.startTime,
      name: (a: Entry, b: Entry) => a.name.localeCompare(b.name),
      club: (a: Entry, b: Entry) => a.clubName.localeCompare(b.clubName),
      card: (a: Entry, b: Entry) => a.cardNo - b.cardNo,
      class: (a: Entry, b: Entry) => a.className.localeCompare(b.className),
    }),
    [],
  );

  const defaultSort = useMemo(
    () =>
      flatView
        ? { key: "startTime" as const, dir: "asc" as const }
        : { key: "startNo" as const, dir: "asc" as const },
    [flatView],
  );
  const { sorted, sort, toggle } = useSort(filtered, defaultSort, comparators);

  // Group by class (only used in grouped view)
  const grouped = useMemo(() => {
    if (flatView) return new Map<string, typeof sorted>();
    const map = new Map<string, typeof sorted>();
    for (const entry of sorted) {
      const list = map.get(entry.className) ?? [];
      list.push(entry);
      map.set(entry.className, list);
    }
    return map;
  }, [sorted, flatView]);

  const handleRunnerClick = (id: number) => {
    setExpandedRunner(expandedRunner === id ? undefined : id);
  };

  return (
    <>
      {/* Toolbar: grouping toggle · search · draw button */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-6">
        <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden self-start sm:self-auto">
          <button
            onClick={() => setFlatView(false)}
            className={`px-2.5 py-1.5 text-sm font-medium transition-colors cursor-pointer ${!flatView ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"
              }`}
            title={t("groupByClass")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </button>
          <button
            onClick={() => setFlatView(true)}
            className={`px-2.5 py-1.5 text-sm font-medium transition-colors cursor-pointer ${flatView ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"
              }`}
            title={t("flatList")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          </button>
        </div>

        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchNameClubCard")}
          suggestionData={suggestionData}
        />

        <button
          onClick={() => setShowDrawPanel(true)}
          className="px-3 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          data-testid="draw-start-times-btn"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {t("drawStartTimes")}
        </button>
      </div>

      {startList.isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      )}

      {tokens.length > 0 && (
        <div className="text-sm text-slate-500 mb-4">
          {t("resultCount", { count: filtered.length })}
        </div>
      )}

      {flatView ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <SortHeader label={t("startNoHash")} active={sort.key === "startNo"} direction={sort.dir} onClick={() => toggle("startNo")} className="w-16" />
                <SortHeader label={t("startTime")} active={sort.key === "startTime"} direction={sort.dir} onClick={() => toggle("startTime")} />
                <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                <SortHeader label={t("class")} active={sort.key === "class"} direction={sort.dir} onClick={() => toggle("class")} />
                <SortHeader label={t("club")} active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} className="hidden sm:table-cell" />
                <SortHeader label={t("card")} active={sort.key === "card"} direction={sort.dir} onClick={() => toggle("card")} className="hidden md:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((entry) => (
                <Fragment key={entry.id}>
                  <tr
                    className={`transition-colors cursor-pointer ${expandedRunner === entry.id ? "bg-blue-50" : "hover:bg-slate-50"
                      }`}
                    onClick={() => handleRunnerClick(entry.id)}
                  >
                    <td className="px-4 py-2.5 text-slate-500 tabular-nums">{entry.startNo > 0 ? entry.startNo : "-"}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900 tabular-nums">
                      {formatMeosTime(entry.startTime)}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-blue-700 hover:text-blue-900">
                      {entry.name}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {entry.className}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1.5">
                        <ClubLogo clubId={entry.clubId} size="sm" />
                        {entry.clubName}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 tabular-nums hidden md:table-cell">
                      {entry.cardNo > 0 ? entry.cardNo : "-"}
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
      ) : (
        [...grouped.entries()].map(([className, classEntries]) => (
          <div key={className} className="mb-8">
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
                {className}
              </h3>
              <span className="text-xs text-slate-400">
                {t("runnersCount", { count: classEntries.length })}
              </span>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <SortHeader label={t("startNoHash")} active={sort.key === "startNo"} direction={sort.dir} onClick={() => toggle("startNo")} className="w-16" />
                    <SortHeader label={t("startTime")} active={sort.key === "startTime"} direction={sort.dir} onClick={() => toggle("startTime")} />
                    <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                    <SortHeader label={t("club")} active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} className="hidden sm:table-cell" />
                    <SortHeader label={t("card")} active={sort.key === "card"} direction={sort.dir} onClick={() => toggle("card")} className="hidden md:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classEntries.map((entry) => (
                    <Fragment key={entry.id}>
                      <tr
                        className={`transition-colors cursor-pointer ${expandedRunner === entry.id ? "bg-blue-50" : "hover:bg-slate-50"
                          }`}
                        onClick={() => handleRunnerClick(entry.id)}
                      >
                        <td className="px-4 py-2.5 text-slate-500 tabular-nums">{entry.startNo > 0 ? entry.startNo : "-"}</td>
                        <td className="px-4 py-2.5 font-medium text-slate-900 tabular-nums">
                          {formatMeosTime(entry.startTime)}
                        </td>
                        <td className="px-4 py-2.5 font-medium text-blue-700 hover:text-blue-900">
                          {entry.name}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">
                          <span className="inline-flex items-center gap-1.5">
                            <ClubLogo clubId={entry.clubId} size="sm" />
                            {entry.clubName}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 tabular-nums hidden md:table-cell">
                          {entry.cardNo > 0 ? entry.cardNo : "-"}
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
        ))
      )}

      {filtered.length === 0 && !startList.isLoading && (
        <div className="text-center py-20 text-slate-400">
          {tokens.length > 0 ? t("noMatchingEntries") : t("noStartListEntries")}
        </div>
      )}

      {showDrawPanel && (
        <DrawPanel
          onClose={() => setShowDrawPanel(false)}
          onDrawComplete={() => {
            utils.lists.startList.invalidate();
            utils.competition.dashboard.invalidate();
          }}
        />
      )}
    </>
  );
}

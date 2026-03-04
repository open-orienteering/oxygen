import { useMemo } from "react";
import { trpc } from "../lib/trpc";
import {
  formatRunningTime,
  RunnerStatus,
  STATUS_FILTER_OPTIONS,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { StatusBadge } from "../components/StatusBadge";
import { RunnerInlineDetail } from "../components/RunnerInlineDetail";
import { ClubLogo } from "../components/ClubLogo";
import { SearchableSelect } from "../components/SearchableSelect";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";

function matchesSearch(
  entry: { name: string; clubName: string; startNo: number },
  term: string,
): boolean {
  const lower = term.toLowerCase();
  if (entry.name.toLowerCase().includes(lower)) return true;
  if (entry.clubName.toLowerCase().includes(lower)) return true;
  if (/^\d+$/.test(term) && entry.startNo > 0 && String(entry.startNo).startsWith(term)) return true;
  return false;
}

function matchesStatusFilter(
  entry: { status: RunnerStatusValue; startTime: number; finishTime: number; hasPunches?: boolean; hasStarted?: boolean },
  filter: string,
): boolean {
  const hasResult = entry.status > 0;
  const hasFinishTime = entry.finishTime > 0;
  const hasPunches = !!entry.hasPunches;
  const hasStarted = !!entry.hasStarted;

  if (filter === "not-started") {
    return !hasResult && !hasFinishTime && !hasPunches && !hasStarted;
  }
  if (filter === "in-forest") {
    return !hasResult && !hasFinishTime && (hasPunches || hasStarted);
  }
  if (filter === "finished") {
    return hasResult || hasFinishTime;
  }
  const statusNum = parseInt(filter, 10);
  if (!isNaN(statusNum)) {
    return entry.status === statusNum;
  }
  return true;
}

export function ResultsPage() {
  const [search, setSearch] = useSearchParam("search");
  const [classFilter, setClassFilter] = useNumericSearchParam("class");
  const [clubFilter, setClubFilter] = useNumericSearchParam("club");
  const [statusFilter, setStatusFilter] = useSearchParam("status");
  const [expandedRunner, setExpandedRunner] = useNumericSearchParam("runner");

  const results = trpc.lists.resultList.useQuery(
    classFilter ? { classId: classFilter } : undefined,
  );
  const dashboard = trpc.competition.dashboard.useQuery();
  const clubs = trpc.competition.clubs.useQuery();

  const entries = results.data ?? [];
  const COL_COUNT = 6;

  // Apply client-side search + club + status filter
  const filtered = useMemo(() => {
    let list = entries;
    if (clubFilter) {
      list = list.filter((e) => e.clubId === clubFilter);
    }
    if (search.trim()) {
      list = list.filter((e) => matchesSearch(e, search.trim()));
    }
    if (statusFilter) {
      list = list.filter((e) => matchesStatusFilter(e, statusFilter));
    }
    return list;
  }, [entries, search, clubFilter, statusFilter]);

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
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Results</h2>
        <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-initial">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search name or club..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64 pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            />
          </div>
          <SearchableSelect
            testId="class-filter"
            value={classFilter ?? ""}
            onChange={(v) => setClassFilter(v ? Number(v) : undefined)}
            placeholder="All classes"
            searchPlaceholder="Search classes..."
            options={[
              { value: "", label: "All classes" },
              ...(dashboard.data?.classes.map((c) => ({
                value: c.id,
                label: c.name,
                suffix: c.runnerCount ? `(${c.runnerCount})` : undefined,
              })) ?? []),
            ]}
          />
          <SearchableSelect
            testId="club-filter"
            value={clubFilter ?? ""}
            onChange={(v) => setClubFilter(v ? Number(v) : undefined)}
            placeholder="All clubs"
            searchPlaceholder="Search clubs..."
            options={[
              { value: "", label: "All clubs" },
              ...(clubs.data?.map((c) => ({
                value: c.id,
                label: c.name,
                icon: <ClubLogo clubId={c.id} size="sm" />,
              })) ?? []),
            ]}
          />
          <SearchableSelect
            testId="status-filter"
            value={statusFilter}
            onChange={(v) => setStatusFilter(String(v))}
            placeholder="All statuses"
            options={STATUS_FILTER_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
          />
        </div>
      </div>

      {results.isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      )}

      {(search.trim() || statusFilter) && (
        <div className="text-sm text-slate-500 mb-4">
          {filtered.length} {filtered.length === 1 ? "result" : "results"}
          {search.trim() ? <> for &ldquo;{search}&rdquo;</> : ""}
          {statusFilter ? ` (filtered by status)` : ""}
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
                  Unofficial
                </span>
              )}
              <span className="text-xs text-slate-400">
                {okCount} classified / {classEntries.length} total
              </span>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <SortHeader label="Place" active={sort.key === "place"} direction={sort.dir} onClick={() => toggle("place")} className="w-14" />
                    <SortHeader label="Name" active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                    <SortHeader label="Club" active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} className="hidden sm:table-cell" />
                    <SortHeader label="Time" active={sort.key === "time"} direction={sort.dir} onClick={() => toggle("time")} align="right" />
                    <SortHeader label="Behind" active={sort.key === "behind"} direction={sort.dir} onClick={() => toggle("behind")} align="right" className="hidden sm:table-cell" />
                    <SortHeader label="Status" active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} className="w-16" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classEntries.map((entry) => (
                    <>
                      <tr
                        key={entry.id}
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
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && !results.isLoading && (
        <div className="text-center py-20 text-slate-400">
          {search.trim() ? "No matching results found" : "No results found"}
        </div>
      )}
    </>
  );
}

import { useState, useMemo, useEffect, Fragment, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import {
  formatMeosTime,
  formatRunningTime,
  STATUS_FILTER_OPTIONS,
  RunnerStatus,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { StatusBadge } from "../components/StatusBadge";
import { RunnerInlineDetail } from "../components/RunnerInlineDetail";
import { RunnerDialog } from "../components/RunnerDialog";
import { ClubLogo } from "../components/ClubLogo";
import { SearchableSelect } from "../components/SearchableSelect";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { useTableSelection } from "../hooks/useTableSelection";
import { BulkActionBar } from "../components/BulkActionBar";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";

export function RunnerManagement() {
  const [search, setSearch] = useSearchParam("search");
  const [classFilter, setClassFilter] = useNumericSearchParam("class");
  const [clubFilter, setClubFilter] = useNumericSearchParam("club");
  const [statusFilter, setStatusFilter] = useSearchParam("status");
  const [expandedRunner, setExpandedRunner] = useNumericSearchParam("runner");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createCardNo, setCreateCardNo] = useState<number | undefined>();
  const [createOwnerData, setCreateOwnerData] = useState<{
    firstName?: string;
    lastName?: string;
    club?: string;
    sex?: string;
    dateOfBirth?: string;
    phone?: string;
  } | undefined>();

  // Auto-open Add Runner dialog when navigated here with ?addCard=12345
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const addCard = searchParams.get("addCard");
    if (addCard) {
      const num = parseInt(addCard, 10);
      if (!isNaN(num) && num > 0) {
        setCreateCardNo(num);
        // Extract optional SI card owner data from URL params
        const owner: typeof createOwnerData = {};
        if (searchParams.get("firstName")) owner.firstName = searchParams.get("firstName")!;
        if (searchParams.get("lastName")) owner.lastName = searchParams.get("lastName")!;
        if (searchParams.get("club")) owner.club = searchParams.get("club")!;
        if (searchParams.get("sex")) owner.sex = searchParams.get("sex")!;
        if (searchParams.get("dob")) owner.dateOfBirth = searchParams.get("dob")!;
        if (searchParams.get("phone")) owner.phone = searchParams.get("phone")!;
        if (Object.keys(owner).length > 0) setCreateOwnerData(owner);
        setShowCreateDialog(true);
      }
      // Remove all addCard-related params so refreshing doesn't re-open
      for (const key of ["addCard", "firstName", "lastName", "club", "sex", "dob", "phone"]) {
        searchParams.delete(key);
      }
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const utils = trpc.useUtils();

  const runners = trpc.runner.list.useQuery({
    classId: classFilter,
    clubId: clubFilter,
    search: search || undefined,
    statusFilter: statusFilter || undefined,
  });
  const classes = trpc.competition.dashboard.useQuery();
  const clubs = trpc.competition.clubs.useQuery();
  const printer = usePrinter();

  const handlePrint = useCallback(async (runnerId: number) => {
    const result = await utils.race.finishReceipt.fetch({ runnerId });
    if (!result) return;
    const competitionInfo = classes.data?.competition;
    const eventorId = classes.data?.organizer?.eventorId;
    await printer.print({
      competitionName: competitionInfo?.name ?? "",
      competitionDate: competitionInfo?.date ?? undefined,
      runner: {
        name: result.runner.name,
        clubName: result.runner.clubName,
        className: result.runner.className,
        startNo: result.runner.startNo,
        cardNo: result.runner.cardNo,
      },
      timing: {
        startTime: result.timing.startTime,
        finishTime: result.timing.finishTime,
        runningTime: result.timing.runningTime,
        status: result.timing.status,
      },
      splits: result.controls.map((c) => ({
        controlIndex: c.controlIndex,
        controlCode: c.controlCode,
        splitTime: c.splitTime,
        cumTime: c.cumTime,
        status: c.status,
        punchTime: c.punchTime,
        legLength: c.legLength,
      })),
      course: result.course ? { name: result.course.name, length: result.course.length } : null,
      position: result.position,
      siac: result.siac,
      classResults: result.classResults,
      logoRaster: eventorId
        ? await fetchLogoRaster(`/api/club-logo/${eventorId}?variant=large`, 250)
        : null,
      qrUrl: competitionInfo?.eventorEventId
        ? `https://eventor.orientering.se/Events/Show/${competitionInfo.eventorEventId}`
        : "https://open-orienteering.org",
    });
  }, [utils, classes.data, printer]);

  const deleteMutation = trpc.runner.delete.useMutation({
    onSuccess: () => {
      utils.runner.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const handleDelete = (runnerId: number, name: string) => {
    if (window.confirm(`Remove "${name}" from the competition?`)) {
      deleteMutation.mutate({ id: runnerId });
    }
  };

  const handleRunnerClick = (id: number) => {
    setExpandedRunner(expandedRunner === id ? undefined : id);
  };

  const rawRunners = runners.data ?? [];

  type Runner = (typeof rawRunners)[number];
  const comparators = useMemo(() => ({
    startNo: (a: Runner, b: Runner) => a.startNo - b.startNo,
    name: (a: Runner, b: Runner) => a.name.localeCompare(b.name),
    club: (a: Runner, b: Runner) => (a.clubName ?? "").localeCompare(b.clubName ?? ""),
    class: (a: Runner, b: Runner) => (a.className ?? "").localeCompare(b.className ?? ""),
    card: (a: Runner, b: Runner) => a.cardNo - b.cardNo,
    start: (a: Runner, b: Runner) => a.startTime - b.startTime,
    time: (a: Runner, b: Runner) => {
      const at = a.finishTime > 0 && a.startTime > 0 ? a.finishTime - a.startTime : Infinity;
      const bt = b.finishTime > 0 && b.startTime > 0 ? b.finishTime - b.startTime : Infinity;
      return at - bt;
    },
    status: (a: Runner, b: Runner) => a.status - b.status,
  }), []);

  const { sorted: filteredRunners, sort, toggle } = useSort(rawRunners, { key: "startNo", dir: "asc" }, comparators);
  const selection = useTableSelection(filteredRunners);

  const [bulkField, setBulkField] = useState<"status" | "class" | "club">("status");
  const [bulkValue, setBulkValue] = useState<string | number>("");

  const bulkUpdateMutation = trpc.runner.bulkUpdate.useMutation({
    onSuccess: () => {
      selection.clearSelection();
      setBulkValue("");
      utils.runner.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const handleApplyBulk = () => {
    if (bulkValue === "") return;
    const count = selection.count;
    const fieldLabel = bulkField === "status" ? "status" : bulkField === "class" ? "class" : "club";

    let valueLabel = "";
    if (bulkField === "status") {
      valueLabel = STATUS_FILTER_OPTIONS.find(o => o.value == bulkValue)?.label ?? String(bulkValue);
    } else if (bulkField === "class") {
      valueLabel = classes.data?.classes.find(c => c.id == bulkValue)?.name ?? String(bulkValue);
    } else if (bulkField === "club") {
      valueLabel = clubs.data?.find(c => c.id == bulkValue)?.name ?? String(bulkValue);
    }

    if (window.confirm(`Set ${fieldLabel} to "${valueLabel}" for ${count} runners?`)) {
      bulkUpdateMutation.mutate({
        ids: Array.from(selection.selected),
        data: {
          [bulkField === "club" ? "clubId" : bulkField === "class" ? "classId" : "status"]: Number(bulkValue)
        }
      });
    }
  };

  const handleDeselectAll = () => selection.clearSelection();

  const COL_COUNT = 10; // Kept this one as it matches the table structure

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search name, club, or card..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
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
            ...(classes.data?.classes.map((c) => ({
              value: c.id,
              label: c.name,
              suffix: `(${c.runnerCount})`,
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
        <button
          onClick={() => setShowCreateDialog(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Runner
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {filteredRunners.length} runners
        </span>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {runners.isLoading && (
          <div className="p-8 text-center">
            <div className="inline-block w-6 h-6 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}
        {filteredRunners.length === 0 && !runners.isLoading && (
          <div className="p-8 text-center text-slate-400 text-sm">
            No runners found
          </div>
        )}
        {filteredRunners.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-2.5 text-left w-10">
                    <input
                      type="checkbox"
                      className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                      checked={selection.allSelected}
                      ref={el => {
                        if (el) el.indeterminate = selection.someSelected && !selection.allSelected;
                      }}
                      onChange={selection.toggleAll}
                    />
                  </th>
                  <SortHeader label="#" active={sort.key === "startNo"} direction={sort.dir} onClick={() => toggle("startNo")} className="w-12" />
                  <SortHeader label="Name" active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                  <SortHeader label="Club" active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} className="hidden sm:table-cell" />
                  <SortHeader label="Class" active={sort.key === "class"} direction={sort.dir} onClick={() => toggle("class")} className="hidden md:table-cell" />
                  <SortHeader label="Card" active={sort.key === "card"} direction={sort.dir} onClick={() => toggle("card")} className="hidden lg:table-cell" />
                  <SortHeader label="Start" active={sort.key === "start"} direction={sort.dir} onClick={() => toggle("start")} />
                  <SortHeader label="Time" active={sort.key === "time"} direction={sort.dir} onClick={() => toggle("time")} />
                  <SortHeader label="Status" active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} />
                  <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRunners.map((runner) => (
                  <Fragment key={runner.id}>
                    <tr
                      className={`transition-colors cursor-pointer ${expandedRunner === runner.id
                        ? "bg-blue-50"
                        : selection.isSelected(runner.id)
                          ? "bg-blue-50/40"
                          : "hover:bg-slate-50"
                        }`}
                      onClick={() => handleRunnerClick(runner.id)}
                    >
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                          checked={selection.isSelected(runner.id)}
                          onChange={() => selection.toggle(runner.id)}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 tabular-nums">{runner.startNo}</td>
                      <td className="px-4 py-2.5 font-medium text-blue-700 hover:text-blue-900">
                        {runner.name}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">
                        <span className="inline-flex items-center gap-1.5">
                          <ClubLogo clubId={runner.clubId} size="sm" />
                          {runner.clubName}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 hidden md:table-cell">{runner.className}</td>
                      <td className="px-4 py-2.5 text-slate-500 tabular-nums hidden lg:table-cell">
                        {runner.cardNo > 0 ? runner.cardNo : "-"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 tabular-nums">{formatMeosTime(runner.startTime)}</td>
                      <td className="px-4 py-2.5 tabular-nums font-medium text-slate-900">
                        {runner.finishTime > 0 && runner.startTime > 0
                          ? formatRunningTime(runner.finishTime - runner.startTime)
                          : "-"}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={runner.status as RunnerStatusValue} />
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {printer.connected && runner.status !== RunnerStatus.Unknown && (
                            <button
                              onClick={() => handlePrint(runner.id)}
                              disabled={printer.printing}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors cursor-pointer disabled:opacity-40"
                              title="Print receipt"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(runner.id, runner.name)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
                            title="Remove runner"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedRunner === runner.id && (
                      <RunnerInlineDetail
                        key={`detail-${runner.id}`}
                        runnerId={runner.id}
                        colSpan={COL_COUNT}
                      />
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateDialog && (
        <RunnerDialog
          mode="create"
          initialCardNo={createCardNo}
          initialOwnerData={createOwnerData}
          onClose={() => {
            setShowCreateDialog(false);
            setCreateCardNo(undefined);
            setCreateOwnerData(undefined);
          }}
          onSuccess={() => {
            setShowCreateDialog(false);
            setCreateCardNo(undefined);
            setCreateOwnerData(undefined);
            utils.runner.list.invalidate();
            utils.competition.dashboard.invalidate();
          }}
        />
      )}

      {/* Bulk actions */}
      <BulkActionBar count={selection.count} onDeselectAll={handleDeselectAll}>
        <div className="flex items-center gap-3">
          <select
            value={bulkField}
            onChange={(e) => {
              setBulkField(e.target.value as "status" | "class" | "club");
              setBulkValue("");
            }}
            className="text-sm border border-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white cursor-pointer"
          >
            <option value="status">Set Status</option>
            <option value="class">Set Class</option>
            <option value="club">Set Club</option>
          </select>

          {bulkField === "status" && (
            <select
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              className="text-sm border border-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white cursor-pointer min-w-[140px]"
            >
              <option value="">Select status...</option>
              {STATUS_FILTER_OPTIONS.filter(o => o.value !== "").map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}

          {bulkField === "class" && (
            <select
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              className="text-sm border border-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white cursor-pointer min-w-[140px]"
            >
              <option value="">Select class...</option>
              {classes.data?.classes.map(cls => (
                <option key={cls.id} value={cls.id}>{cls.name}</option>
              ))}
            </select>
          )}

          {bulkField === "club" && (
            <select
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              className="text-sm border border-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white cursor-pointer min-w-[140px]"
            >
              <option value="">Select club...</option>
              {clubs.data?.map(club => (
                <option key={club.id} value={club.id}>{club.name}</option>
              ))}
            </select>
          )}

          <button
            onClick={handleApplyBulk}
            disabled={bulkValue === "" || bulkUpdateMutation.isPending}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2"
          >
            {bulkUpdateMutation.isPending && (
              <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            Apply to {selection.count}
          </button>
        </div>
      </BulkActionBar>
    </>
  );
}

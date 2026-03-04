import { useState, useMemo } from "react";
import { trpc } from "../lib/trpc";
import {
  controlStatusLabel,
  CONTROL_STATUS_OPTIONS,
  type ControlStatusValue,
  type ControlDetail,
} from "@oxygen/shared";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { MapPanel } from "../components/MapPanel";

export function ControlsPage() {
  const [search, setSearch] = useSearchParam("search");
  const [statusFilter, setStatusFilter] = useSearchParam("status");
  const [expandedId, setExpandedId] = useNumericSearchParam("control");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const utils = trpc.useUtils();

  const controls = trpc.control.list.useQuery({
    search: search || undefined,
    status: statusFilter ? parseInt(statusFilter, 10) : undefined,
  });

  const deleteMutation = trpc.control.delete.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
      utils.control.detail.invalidate();
    },
  });

  const handleDelete = (id: number) => {
    if (window.confirm(`Remove control ${id}?`)) {
      deleteMutation.mutate({ id });
    }
  };

  const handleToggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? undefined : id);
  };

  type Ctrl = NonNullable<typeof controls.data>[number];
  const comparators = useMemo(() => ({
    code: (a: Ctrl, b: Ctrl) => a.id - b.id,
    name: (a: Ctrl, b: Ctrl) => a.name.localeCompare(b.name),
    codes: (a: Ctrl, b: Ctrl) => a.codes.localeCompare(b.codes),
    status: (a: Ctrl, b: Ctrl) => a.status - b.status,
    runners: (a: Ctrl, b: Ctrl) => a.runnerCount - b.runnerCount,
    timeAdjust: (a: Ctrl, b: Ctrl) => a.timeAdjust - b.timeAdjust,
    minTime: (a: Ctrl, b: Ctrl) => a.minTime - b.minTime,
  }), []);

  const { sorted: items, sort, toggle } = useSort(controls.data ?? [], { key: "code", dir: "asc" }, comparators);

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
            placeholder="Search code, name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          <option value="">All statuses</option>
          {CONTROL_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} -- {opt.description}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Control
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {items.length} controls
        </span>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateControlForm
          onClose={() => setShowCreateForm(false)}
          onCreated={() => {
            setShowCreateForm(false);
            utils.control.list.invalidate();
          }}
        />
      )}

      {/* Controls table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {controls.isLoading && (
          <div className="p-8 text-center">
            <div className="inline-block w-6 h-6 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}
        {items.length === 0 && !controls.isLoading && (
          <div className="p-8 text-center text-slate-400 text-sm">
            No controls found
          </div>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <SortHeader label="Code" active={sort.key === "code"} direction={sort.dir} onClick={() => toggle("code")} className="w-20" />
                  <SortHeader label="Name" active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                  <SortHeader label="Punch Codes" active={sort.key === "codes"} direction={sort.dir} onClick={() => toggle("codes")} />
                  <SortHeader label="Status" active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} className="w-28" />
                  <SortHeader label="Runners" active={sort.key === "runners"} direction={sort.dir} onClick={() => toggle("runners")} className="w-24" />
                  <SortHeader label="Time Adj." active={sort.key === "timeAdjust"} direction={sort.dir} onClick={() => toggle("timeAdjust")} className="hidden md:table-cell w-28" />
                  <SortHeader label="Min Time" active={sort.key === "minTime"} direction={sort.dir} onClick={() => toggle("minTime")} className="hidden md:table-cell w-28" />
                  <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-20">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((ctrl) => (
                  <>
                    <tr
                      key={ctrl.id}
                      className={`transition-colors cursor-pointer ${
                        expandedId === ctrl.id ? "bg-blue-50" : "hover:bg-slate-50"
                      }`}
                      onClick={() => handleToggleExpand(ctrl.id)}
                    >
                      <td className="px-4 py-2.5 font-mono font-bold text-blue-700 tabular-nums">
                        {ctrl.status === 4 || ctrl.status === 5 ? <span className="text-slate-300">—</span> : ctrl.id}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {ctrl.name || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-600 tabular-nums">
                        {ctrl.status === 4 || ctrl.status === 5 ? <span className="text-slate-300">—</span> : ctrl.codes}
                      </td>
                      <td className="px-4 py-2.5">
                        <ControlStatusBadge status={ctrl.status as ControlStatusValue} />
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 tabular-nums">
                        {ctrl.runnerCount > 0 ? ctrl.runnerCount : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 tabular-nums hidden md:table-cell">
                        {ctrl.timeAdjust !== 0 ? formatTimeAdjust(ctrl.timeAdjust) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 tabular-nums hidden md:table-cell">
                        {ctrl.minTime > 0 ? formatSeconds(ctrl.minTime) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleDelete(ctrl.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
                          title="Remove control"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                    {expandedId === ctrl.id && (
                      <tr key={`detail-${ctrl.id}`}>
                        <td colSpan={8} className="p-0">
                          <ControlInlineDetail controlId={ctrl.id} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Map */}
      <MapPanel
        className="mt-6"
        highlightControlId={expandedId ?? undefined}
      />
    </>
  );
}

// ─── Status badge ────────────────────────────────────────────

function ControlStatusBadge({ status }: { status: ControlStatusValue }) {
  const label = controlStatusLabel(status);
  let cls = "px-2 py-0.5 rounded-full text-xs font-medium ";
  if (status === 0) cls += "bg-green-100 text-green-800";
  else if (status === 1 || status === 9) cls += "bg-red-100 text-red-800";
  else if (status === 2) cls += "bg-purple-100 text-purple-800";
  else if (status === 4 || status === 5 || status === 11) cls += "bg-blue-100 text-blue-800";
  else cls += "bg-slate-100 text-slate-600";
  return <span className={cls}>{label}</span>;
}

// ─── Helpers ─────────────────────────────────────────────────

function formatTimeAdjust(seconds: number): string {
  const sign = seconds >= 0 ? "+" : "-";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}:${s.toString().padStart(2, "0")}`;
}

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Inline detail (expanded view) ──────────────────────────

function ControlInlineDetail({ controlId }: { controlId: number }) {
  const utils = trpc.useUtils();
  const detail = trpc.control.detail.useQuery({ id: controlId });
  const updateMutation = trpc.control.update.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
      utils.control.detail.invalidate();
    },
  });

  const [editName, setEditName] = useState<string | null>(null);
  const [editCodes, setEditCodes] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<number | null>(null);

  if (detail.isLoading) {
    return (
      <div className="bg-blue-50/60 p-6 text-center">
        <div className="inline-block w-5 h-5 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!detail.data) {
    return (
      <div className="bg-blue-50/60 p-6 text-center text-slate-400 text-sm">
        Control not found
      </div>
    );
  }

  const d = detail.data;

  const handleSave = (field: string, value: string | number) => {
    updateMutation.mutate({ id: controlId, [field]: value });
  };

  return (
    <div className="bg-blue-50/60 border-t border-blue-100 p-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Editable fields */}
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Control Settings
          </h4>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
            <input
              type="text"
              value={editName ?? d.name}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => {
                if (editName !== null && editName !== d.name) {
                  handleSave("name", editName);
                }
                setEditName(null);
              }}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Radio 1, Förvarning..."
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Punch Code(s)</label>
            <input
              type="text"
              value={editCodes ?? d.codes}
              onChange={(e) => setEditCodes(e.target.value)}
              onBlur={() => {
                if (editCodes !== null && editCodes !== d.codes) {
                  handleSave("codes", editCodes);
                }
                setEditCodes(null);
              }}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. 31 or 31;250"
            />
            <p className="text-xs text-slate-400 mt-1">
              Separate multiple codes with semicolons for replacements or forks
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <select
              value={editStatus ?? d.status}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setEditStatus(val);
                handleSave("status", val);
              }}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              {CONTROL_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Course usage */}
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Used in Courses
          </h4>
          {d.courses.length === 0 ? (
            <p className="text-sm text-slate-400">Not used in any course</p>
          ) : (
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
              {d.courses.map((cu) => (
                <div key={cu.courseId} className="px-4 py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-slate-700">
                      {cu.courseName}
                    </span>
                    {cu.occurrences > 1 && (
                      <span className="ml-2 text-xs text-amber-600 font-medium">
                        ×{cu.occurrences}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {cu.runnerCount} runner{cu.runnerCount !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
              <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500">
                Total: {d.courses.reduce((sum, c) => sum + c.runnerCount, 0)} runners across {d.courses.length} course{d.courses.length !== 1 ? "s" : ""}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Create control form ─────────────────────────────────────

function CreateControlForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [codes, setCodes] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState(0);

  const createMutation = trpc.control.create.useMutation({
    onSuccess: () => onCreated(),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!codes.trim()) return;
    createMutation.mutate({ codes: codes.trim(), name: name.trim(), status });
  };

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900">New Control</h3>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-600 rounded cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Punch Code(s)
          </label>
          <input
            type="text"
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder="e.g. 50 or 50;250"
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
            required
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Radio 1 (optional)"
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="sm:w-40">
          <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(parseInt(e.target.value, 10))}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            {CONTROL_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            disabled={createMutation.isPending || !codes.trim()}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-slate-500 text-sm hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </form>
      {createMutation.isError && (
        <div className="mt-3 text-sm text-red-600">
          {createMutation.error.message}
        </div>
      )}
    </div>
  );
}

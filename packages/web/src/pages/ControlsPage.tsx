import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import {
  ControlStatus,
  controlStatusLabel,
  CONTROL_STATUS_OPTIONS,
  type ControlStatusValue,
  type ControlInfo,
  type RadioType,
  type AirPlusOverride,
} from "@oxygen/shared";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { MapPanel } from "../components/MapPanel";
import { useDeviceManager } from "../context/DeviceManager";
import { STATION_MODE, type StationInfo } from "../lib/si-protocol";

// ─── Types ────────────────────────────────────────────────

type StationMode = null | "programming" | "readout";

interface ProgramResult {
  controlId: number;
  code: number;
  batteryVoltage: number;
  batteryCapMah?: number; // battery capacity consumed %
  batteryLow: boolean;
  success: boolean;
  error?: string;
  timeDriftMs?: number | null;
  backupCleared?: number;
  poweredOff?: boolean;
  timestamp: Date;
}

// ─── Main component ──────────────────────────────────────

export function ControlsPage() {
  const { t } = useTranslation("controls");
  const [search, setSearch] = useSearchParam("search");
  const [statusFilter, setStatusFilter] = useSearchParam("status");
  const [expandedId, setExpandedId] = useNumericSearchParam("control");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Station mode
  const [stationMode, setStationMode] = useState<StationMode>(null);

  const utils = trpc.useUtils();

  const controls = trpc.control.list.useQuery({
    search: search || undefined,
    status: statusFilter ? parseInt(statusFilter, 10) : undefined,
  });

  const airPlusConfig = trpc.control.getAirPlusConfig.useQuery();

  const deleteMutation = trpc.control.delete.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
      utils.control.detail.invalidate();
    },
  });

  const upsertConfigMutation = trpc.control.upsertConfig.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
      utils.control.detail.invalidate();
    },
  });

  const setAirPlusMutation = trpc.control.setAirPlusConfig.useMutation({
    onSuccess: () => {
      utils.control.getAirPlusConfig.invalidate();
    },
  });

  const handleDelete = (id: number) => {
    if (window.confirm(t("removeConfirm", { id }))) {
      deleteMutation.mutate({ id });
    }
  };

  const handleToggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? undefined : id);
  };

  // Multi-select handlers
  const toggleSelect = useCallback((id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!controls.data) return;
    // Only select regular controls (not start/finish)
    const selectableIds = controls.data
      .filter((c) => c.status !== 4 && c.status !== 5)
      .map((c) => c.id);
    setSelectedIds((prev) =>
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds),
    );
  }, [controls.data]);

  // Bulk actions
  const handleBulkRadioType = (type: RadioType) => {
    if (selectedIds.size === 0) return;
    upsertConfigMutation.mutate({
      controlIds: Array.from(selectedIds),
      radioType: type,
    });
  };

  const handleBulkAirPlus = (value: AirPlusOverride) => {
    if (selectedIds.size === 0) return;
    upsertConfigMutation.mutate({
      controlIds: Array.from(selectedIds),
      airPlus: value,
    });
  };

  type Ctrl = NonNullable<typeof controls.data>[number];
  const comparators = useMemo(() => ({
    code: (a: Ctrl, b: Ctrl) => a.id - b.id,
    name: (a: Ctrl, b: Ctrl) => a.name.localeCompare(b.name),
    codes: (a: Ctrl, b: Ctrl) => a.codes.localeCompare(b.codes),
    status: (a: Ctrl, b: Ctrl) => a.status - b.status,
    runners: (a: Ctrl, b: Ctrl) => a.runnerCount - b.runnerCount,
    radio: (a: Ctrl, b: Ctrl) =>
      (a.config?.radioType ?? "normal").localeCompare(b.config?.radioType ?? "normal"),
    checked: (a: Ctrl, b: Ctrl) =>
      (a.config?.checkedAt ?? "").localeCompare(b.config?.checkedAt ?? ""),
  }), []);

  const { sorted: items, sort, toggle } = useSort(controls.data ?? [], { key: "code", dir: "asc" }, comparators);

  const selectableItems = items.filter((c) => c.status !== 4 && c.status !== 5);

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
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
          <option value="">{t("allStatuses")}</option>
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
          {t("newControl")}
        </button>
      </div>

      {/* AIR+ toggle + station mode buttons */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500">
            {t("controlsCount", { count: items.length })}
          </span>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600 font-medium">{t("airPlus")}</span>
            <button
              onClick={() => setAirPlusMutation.mutate({ enabled: !airPlusConfig.data?.airPlusEnabled })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${
                airPlusConfig.data?.airPlusEnabled ? "bg-blue-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  airPlusConfig.data?.airPlusEnabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600 font-medium">{t("awake")}</span>
            <select
              value={airPlusConfig.data?.awakeHours ?? 6}
              onChange={(e) => setAirPlusMutation.mutate({ awakeHours: parseInt(e.target.value, 10) })}
              className="px-2 py-0.5 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>{h}h</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStationMode(stationMode === "programming" ? null : "programming")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
              stationMode === "programming"
                ? "bg-blue-600 text-white"
                : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {t("programControls")}
          </button>
          <button
            onClick={() => setStationMode(stationMode === "readout" ? null : "readout")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
              stationMode === "readout"
                ? "bg-amber-600 text-white"
                : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t("readControls")}
          </button>
        </div>
      </div>

      {/* Station panel */}
      {stationMode === "programming" && (
        <ProgrammingPanel
          controls={controls.data ?? []}
          airPlusEnabled={airPlusConfig.data?.airPlusEnabled ?? false}
          awakeHours={airPlusConfig.data?.awakeHours ?? 6}
          onProgrammed={() => utils.control.list.invalidate()}
          onClose={() => setStationMode(null)}
        />
      )}
      {stationMode === "readout" && (
        <ReadoutPanel
          controls={controls.data ?? []}
          onClose={() => setStationMode(null)}
        />
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-blue-800">
            {t("selectedCount", { count: selectedIds.size })}
          </span>
          <div className="flex items-center gap-2">
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) handleBulkRadioType(e.target.value as RadioType);
                e.target.value = "";
              }}
              className="px-2 py-1 text-sm border border-blue-200 rounded-lg bg-white cursor-pointer"
            >
              <option value="" disabled>{t("setRadioType")}</option>
              <option value="normal">{t("normal")}</option>
              <option value="internal_radio">{t("internalRadio")}</option>
              <option value="public_radio">{t("publicRadio")}</option>
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) handleBulkAirPlus(e.target.value as AirPlusOverride);
                e.target.value = "";
              }}
              className="px-2 py-1 text-sm border border-blue-200 rounded-lg bg-white cursor-pointer"
            >
              <option value="" disabled>{t("setAirPlus")}</option>
              <option value="default">{t("airPlusDefault")}</option>
              <option value="on">{t("airPlusOn")}</option>
              <option value="off">{t("airPlusOff")}</option>
            </select>
          </div>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-blue-600 hover:text-blue-800 cursor-pointer ml-auto"
          >
            {t("clearSelection")}
          </button>
        </div>
      )}

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
            {t("noControls")}
          </div>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && selectedIds.size === selectableItems.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < selectableItems.length;
                      }}
                      onChange={toggleSelectAll}
                      className="rounded border-slate-300 cursor-pointer"
                    />
                  </th>
                  <SortHeader label={t("code")} active={sort.key === "code"} direction={sort.dir} onClick={() => toggle("code")} className="w-20" />
                  <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                  <SortHeader label={t("status")} active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} className="w-28" />
                  <SortHeader label={t("radio")} active={sort.key === "radio"} direction={sort.dir} onClick={() => toggle("radio")} className="w-28" />
                  <SortHeader label={t("runners")} active={sort.key === "runners"} direction={sort.dir} onClick={() => toggle("runners")} className="w-24" />
                  <SortHeader label={t("checked")} active={sort.key === "checked"} direction={sort.dir} onClick={() => toggle("checked")} className="hidden lg:table-cell w-32" />
                  <th className="px-4 py-2.5 text-left font-medium text-slate-500 hidden lg:table-cell w-24">{t("battery")}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-20">{t("actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((ctrl) => (
                  <ControlRow
                    key={ctrl.id}
                    ctrl={ctrl}
                    expanded={expandedId === ctrl.id}
                    selected={selectedIds.has(ctrl.id)}
                    onToggleExpand={() => handleToggleExpand(ctrl.id)}
                    onToggleSelect={(e) => toggleSelect(ctrl.id, e)}
                    onDelete={() => handleDelete(ctrl.id)}
                  />
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

// ─── Control row ──────────────────────────────────────────

function ControlRow({
  ctrl,
  expanded,
  selected,
  onToggleExpand,
  onToggleSelect,
  onDelete,
}: {
  ctrl: ControlInfo;
  expanded: boolean;
  selected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: (e: React.MouseEvent) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("controls");
  const isStartFinish = ctrl.status === 4 || ctrl.status === 5;
  const config = ctrl.config;

  return (
    <>
      <tr
        className={`transition-colors cursor-pointer ${
          expanded ? "bg-blue-50" : "hover:bg-slate-50"
        }`}
        onClick={onToggleExpand}
      >
        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
          {!isStartFinish && (
            <input
              type="checkbox"
              checked={selected}
              onClick={onToggleSelect}
              onChange={() => {}}
              className="rounded border-slate-300 cursor-pointer"
            />
          )}
        </td>
        <td className="px-4 py-2.5 font-mono font-bold text-blue-700 tabular-nums">
          {isStartFinish ? <span className="text-slate-300">—</span> : ctrl.id}
        </td>
        <td className="px-4 py-2.5 text-slate-700">
          {ctrl.name || <span className="text-slate-300">—</span>}
        </td>
        <td className="px-4 py-2.5">
          <ControlStatusBadge status={ctrl.status as ControlStatusValue} />
        </td>
        <td className="px-4 py-2.5">
          {!isStartFinish ? <RadioTypeBadge type={config?.radioType ?? "normal"} /> : <span className="text-slate-300">—</span>}
        </td>
        <td className="px-4 py-2.5 text-slate-600 tabular-nums">
          {ctrl.runnerCount > 0 ? ctrl.runnerCount : <span className="text-slate-300">—</span>}
        </td>
        <td className="px-4 py-2.5 hidden lg:table-cell">
          <CheckedIndicator checkedAt={config?.checkedAt ?? null} />
        </td>
        <td className="px-4 py-2.5 hidden lg:table-cell">
          <BatteryIndicator voltage={config?.batteryVoltage ?? null} low={config?.batteryLow ?? null} />
        </td>
        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
            title={t("removeControl")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </td>
      </tr>
      {expanded && (
        <tr key={`detail-${ctrl.id}`}>
          <td colSpan={9} className="p-0">
            <ControlInlineDetail controlId={ctrl.id} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Badges & indicators ──────────────────────────────────

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

function RadioTypeBadge({ type }: { type: RadioType }) {
  const { t } = useTranslation("controls");
  if (type === "normal") return <span className="text-slate-300">—</span>;
  if (type === "internal_radio") {
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">{t("internalRadio")}</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">{t("publicRadio")}</span>;
}

function CheckedIndicator({ checkedAt }: { checkedAt: string | null }) {
  if (!checkedAt) return <span className="text-slate-300">—</span>;
  const ago = relativeTime(new Date(checkedAt));
  return (
    <span className="flex items-center gap-1.5 text-xs text-green-700">
      <span className="w-2 h-2 rounded-full bg-green-500" />
      {ago}
    </span>
  );
}

function BatteryIndicator({ voltage, low }: { voltage: number | null; low: boolean | null }) {
  if (voltage === null) return <span className="text-slate-300">—</span>;
  const color = low ? "text-red-600" : voltage < 3.0 ? "text-amber-600" : "text-green-600";
  return <span className={`text-xs font-mono tabular-nums ${color}`}>{voltage.toFixed(2)}V</span>;
}

// ─── Helpers ─────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Inline detail (expanded view) ──────────────────────

function ControlInlineDetail({ controlId }: { controlId: number }) {
  const { t } = useTranslation("controls");
  const utils = trpc.useUtils();
  const detail = trpc.control.detail.useQuery({ id: controlId });
  const updateMutation = trpc.control.update.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
      utils.control.detail.invalidate();
    },
  });
  const upsertConfigMutation = trpc.control.upsertConfig.useMutation({
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
        {t("controlNotFound")}
      </div>
    );
  }

  const d = detail.data;
  const config = d.config;
  const isStartFinish = d.status === 4 || d.status === 5;

  const handleSave = (field: string, value: string | number) => {
    updateMutation.mutate({ id: controlId, [field]: value });
  };

  return (
    <div className="bg-blue-50/60 border-t border-blue-100 p-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Editable fields */}
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("controlSettings")}
          </h4>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("name")}</label>
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
              placeholder={t("namePlaceholder")}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("punchCodes")}</label>
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
              placeholder={t("punchCodesPlaceholder")}
            />
            <p className="text-xs text-slate-400 mt-1">
              {t("punchCodesHelp")}
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("status")}</label>
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

        {/* Radio/AIR+ config */}
        {!isStartFinish && (
          <div className="space-y-4">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              {t("radioAirPlusConfig")}
            </h4>

            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("radioType")}</label>
              <select
                value={config?.radioType ?? "normal"}
                onChange={(e) => {
                  upsertConfigMutation.mutate({
                    controlIds: [controlId],
                    radioType: e.target.value as RadioType,
                  });
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="normal">{t("normal")}</option>
                <option value="internal_radio">{t("internalRadioSRR")}</option>
                <option value="public_radio">{t("publicRadioSRR")}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("airPlusOverride")}</label>
              <select
                value={config?.airPlus ?? "default"}
                onChange={(e) => {
                  upsertConfigMutation.mutate({
                    controlIds: [controlId],
                    airPlus: e.target.value as AirPlusOverride,
                  });
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="default">{t("airPlusDefaultDesc")}</option>
                <option value="on">{t("airPlusOn")}</option>
                <option value="off">{t("airPlusOff")}</option>
              </select>
            </div>

            {config?.checkedAt && (
              <div className="text-xs text-slate-500 space-y-1">
                <div>{t("checkedLabel", { time: relativeTime(new Date(config.checkedAt)) })}</div>
                {config.batteryVoltage !== null && (
                  <div>{t("batteryLabel", { voltage: config.batteryVoltage.toFixed(2) })} {config.batteryLow ? t("batteryLow") : ""}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Course usage */}
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            {t("usedInCourses")}
          </h4>
          {d.courses.length === 0 ? (
            <p className="text-sm text-slate-400">{t("notUsedInAnyCourse")}</p>
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
                    {t("runnerCount", { count: cu.runnerCount })}
                  </span>
                </div>
              ))}
              <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500">
                {t("totalRunnersAcrossCourses", { runners: d.courses.reduce((sum, c) => sum + c.runnerCount, 0), courses: d.courses.length })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Create control form ─────────────────────────────────

function CreateControlForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("controls");
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
        <h3 className="text-sm font-semibold text-slate-900">{t("newControl")}</h3>
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
            {t("punchCodes")}
          </label>
          <input
            type="text"
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder={t("codesPlaceholder")}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
            required
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("nameCreatePlaceholder")}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="sm:w-40">
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("status")}</label>
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
            {createMutation.isPending ? t("creating") : t("create")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-slate-500 text-sm hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            {t("cancel")}
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

// ─── Programming panel ───────────────────────────────────

function ProgrammingPanel({
  controls,
  airPlusEnabled,
  awakeHours,
  onProgrammed,
  onClose,
}: {
  controls: ControlInfo[];
  airPlusEnabled: boolean;
  awakeHours: number;
  onProgrammed: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("controls");
  const { readerStatus, getReaderConnection, connectReader } = useDeviceManager();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ProgramResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoPowerOff, setAutoPowerOff] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [targetControlId, setTargetControlId] = useState<number | "auto">("auto");
  const [ntpStatus, setNtpStatus] = useState<{
    browserToServerMs: number;
    serverNtpMs: number | null;
    ntpSource: string | null;
  } | "checking" | "failed" | null>("checking");
  const utils = trpc.useUtils();

  // Clock verification on mount — API returns server time + its own NTP check
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t1 = Date.now();
        const result = await utils.control.serverTime.fetch();
        const t2 = Date.now();
        if (cancelled) return;
        const localMidpoint = (t1 + t2) / 2;
        const browserToServerMs = Math.round(localMidpoint - result.unixMs);
        setNtpStatus({
          browserToServerMs,
          serverNtpMs: result.ntpDriftMs ?? null,
          ntpSource: result.ntpSource ?? null,
        });
      } catch {
        if (!cancelled) setNtpStatus("failed");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Restore direct mode on unmount (navigation away, panel toggle, etc.)
  useEffect(() => {
    return () => {
      try { getReaderConnection().restoreDirectMode().catch(() => {}); } catch {}
    };
  }, [getReaderConnection]);

  // Track last programmed serial to avoid re-programming the same control
  const lastProgrammedSerial = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const pollCooldownRef = useRef(0);
  const autoModeRef = useRef(false);
  autoModeRef.current = autoMode;
  const autoPowerOffRef = useRef(false);
  autoPowerOffRef.current = autoPowerOff;

  const connected = readerStatus === "connected" || readerStatus === "reading";

  const recordMutation = trpc.control.recordProgramming.useMutation({
    onSuccess: () => onProgrammed(),
  });

  const programStation = useCallback(async (
    reader: ReturnType<typeof getReaderConnection>,
    rawData: Uint8Array,
    stationInfo: { stationCode: number; batteryVoltage: number; serialNo: number; backupCount: number },
  ) => {
    const readCode = stationInfo.stationCode;

    // Resolve target control: explicit selection or auto-match by station code
    let matchedControl: ControlInfo | undefined;
    if (targetControlId !== "auto") {
      matchedControl = controls.find((c) => c.id === targetControlId);
    } else {
      matchedControl = controls.find((c) => {
        const codes = c.codes.split(";").map((s) => parseInt(s.trim(), 10));
        return codes.includes(readCode);
      });
    }

    if (!matchedControl) {
      const result: ProgramResult = {
        controlId: 0,
        code: readCode,
        batteryVoltage: stationInfo.batteryVoltage,
        batteryLow: false,
        success: false,
        error: t("controlNotInCompetition", { code: readCode }),
        timestamp: new Date(),
      };
      setResults((prev) => [result, ...prev].slice(0, 20));
      return;
    }

    // Use the target control's first code (for reprogramming scenarios)
    const targetCode = parseInt(matchedControl.codes.split(";")[0].trim(), 10);

    // Determine settings
    const config = matchedControl.config;
    const enableSRR = config?.radioType === "internal_radio" || config?.radioType === "public_radio";
    const airPlusOverride = config?.airPlus ?? "default";
    const isNonAirPlusType =
      matchedControl.status === ControlStatus.Check ||
      matchedControl.status === ControlStatus.Clear;
    const enableAirPlus = isNonAirPlusType
      ? false
      : airPlusOverride === "on" || (airPlusOverride === "default" && airPlusEnabled);

    // Compute SI station mode from control status
    let stationMode: number | undefined;
    switch (matchedControl.status) {
      case ControlStatus.Start:
        stationMode = enableAirPlus ? STATION_MODE.BC_START : STATION_MODE.START;
        break;
      case ControlStatus.Finish:
        stationMode = enableAirPlus ? STATION_MODE.BC_FINISH : STATION_MODE.FINISH;
        break;
      case ControlStatus.Check:
        stationMode = STATION_MODE.CHECK;
        break;
      case ControlStatus.Clear:
        stationMode = STATION_MODE.CLEAR;
        break;
    }

    // Program the field control (pass rawData to skip redundant read)
    const { batteryVoltage, stationInfo: progInfo, timeDriftMs } = await reader.programControl({
      code: targetCode,
      enableSRR,
      enableAirPlus,
      awakeHours: awakeHours ?? 6,
      beep: false,
      stationMode,
    }, rawData);

    const batteryLow = batteryVoltage < 2.5;

    // Power off if enabled (read from ref for guaranteed freshness in auto-poll)
    let poweredOff = false;
    if (autoPowerOffRef.current) {
      try {
        await reader.powerOffStation();
        poweredOff = true;
        // Suppress polling for 2s so the coupling coil doesn't wake
        // the field control before it finishes powering down
        pollCooldownRef.current = Date.now() + 2000;
      } catch {
        // Ignore power-off failure
      }
    }

    // Record in DB
    recordMutation.mutate({
      controlId: matchedControl.id,
      batteryVoltage,
      memoryClearedAt: true,
    });

    lastProgrammedSerial.current = stationInfo.serialNo;

    const result: ProgramResult = {
      controlId: matchedControl.id,
      code: targetCode,
      batteryVoltage,
      batteryCapMah: progInfo.batteryCapMah,
      batteryLow,
      success: true,
      timeDriftMs,
      poweredOff,
      timestamp: new Date(),
    };
    setResults((prev) => [result, ...prev].slice(0, 20));
  }, [controls, airPlusEnabled, awakeHours, targetControlId, recordMutation, t]);

  const handleProgram = async () => {
    const reader = getReaderConnection();
    setBusy(true);
    setError(null);

    try {
      const { rawData, ...info } = await reader.readConnectedStation();
      await programStation(reader, rawData, info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Programming failed");
    } finally {
      setBusy(false);
    }
  };

  // Auto-polling loop
  useEffect(() => {
    if (!autoMode || !connected) return;

    let cancelled = false;

    const poll = async () => {
      if (pollingRef.current || cancelled) return;
      // After power-off, pause polling so the coupling coil doesn't
      // wake the field control before it finishes powering down
      if (Date.now() < pollCooldownRef.current) return;
      pollingRef.current = true;

      try {
        const reader = getReaderConnection();
        const result = await reader.probeConnectedStation();

        if (cancelled || !autoModeRef.current) return;

        if (result && result.serialNo !== lastProgrammedSerial.current) {
          // New control detected — program it
          setBusy(true);
          setError(null);
          try {
            await programStation(reader, result.rawData, result);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Programming failed");
          } finally {
            setBusy(false);
          }
        }
      } catch {
        // Probe failed — ignore, will retry
      } finally {
        pollingRef.current = false;
      }
    };

    poll();
    const interval = setInterval(poll, 500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [autoMode, connected, getReaderConnection, programStation]);

  const handleClose = async () => {
    // Restore BSM8 to direct mode for normal card readout
    try {
      const reader = getReaderConnection();
      await reader.restoreDirectMode();
    } catch {
      // Ignore — reader may not be connected
    }
    onClose();
  };

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-slate-300"}`} />
          <h3 className="text-sm font-semibold text-slate-800">{t("preCompProgramming")}</h3>
        </div>
        <div className="flex items-center gap-2">
          {!connected ? (
            <button
              onClick={() => connectReader()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 cursor-pointer"
            >
              {t("connectStation")}
            </button>
          ) : (
            <button
              onClick={handleProgram}
              disabled={busy || autoMode}
              className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 cursor-pointer"
            >
              {busy ? t("programmingStation") : t("readAndProgram")}
            </button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMode}
              onChange={(e) => {
                setAutoMode(e.target.checked);
                if (!e.target.checked) lastProgrammedSerial.current = null;
              }}
              disabled={!connected}
              className="rounded"
            />
            {t("auto")}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoPowerOff}
              onChange={(e) => setAutoPowerOff(e.target.checked)}
              className="rounded"
            />
            {t("powerOff")}
          </label>
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-sm bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 cursor-pointer"
          >
            {t("close")}
          </button>
        </div>
      </div>

      {/* Target control selector */}
      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs text-slate-600">{t("targetControl")}:</label>
        <select
          value={targetControlId}
          onChange={(e) => setTargetControlId(e.target.value === "auto" ? "auto" : Number(e.target.value))}
          className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
        >
          <option value="auto">{t("targetAuto")}</option>
          {controls.map((c) => (
            <option key={c.id} value={c.id}>
              {c.codes}{c.name ? ` — ${c.name}` : ""} ({controlStatusLabel(c.status)})
            </option>
          ))}
        </select>
      </div>

      {/* Clock verification */}
      {ntpStatus === "checking" && (
        <div className="text-xs text-slate-500 px-3 py-1.5 mb-2">{t("verifyingClocks")}</div>
      )}
      {ntpStatus === "failed" && (
        <div className="text-xs text-amber-700 bg-amber-50 px-3 py-1.5 rounded-lg mb-2">
          {t("clockVerifyFailed")}
        </div>
      )}
      {typeof ntpStatus === "object" && ntpStatus !== null && (() => {
        const { browserToServerMs, serverNtpMs, ntpSource } = ntpStatus;
        // Total drift = browser vs NTP (if available), otherwise browser vs server
        const totalDriftMs = serverNtpMs !== null ? browserToServerMs + serverNtpMs : browserToServerMs;
        const hasNtp = serverNtpMs !== null;
        const isOk = Math.abs(totalDriftMs) <= 2000;
        const serverNtpOk = hasNtp && Math.abs(serverNtpMs) <= 2000;

        if (!isOk) {
          return (
            <div className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg mb-2 font-medium">
              {t("clockOffBy", { drift: Math.abs(totalDriftMs) >= 1000 ? `${(totalDriftMs / 1000).toFixed(1)}s` : `${Math.abs(totalDriftMs)}ms` })}
            </div>
          );
        }

        return (
          <div className="text-xs text-green-700 px-3 py-1 mb-2">
            {t("clockOk")}
            {hasNtp
              ? ` (${serverNtpOk ? "verified" : "unverified server"} via ${ntpSource}, drift: ${totalDriftMs >= 0 ? "+" : ""}${totalDriftMs}ms)`
              : ` (vs API server, drift: ${browserToServerMs >= 0 ? "+" : ""}${browserToServerMs}ms — NTP unavailable)`
            }
          </div>
        );
      })()}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{error}</div>
      )}

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {results.map((r, i) => (
            <div
              key={i}
              className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                r.success ? "bg-white" : "bg-red-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${r.success ? "bg-green-500" : "bg-red-500"}`} />
                <span className="font-mono font-bold">{r.code}</span>
                {r.success ? (
                  <span className="text-green-700">{t("programmed")}</span>
                ) : (
                  <span className="text-red-600">{r.error}</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                {r.timeDriftMs != null && (
                  <span className={`font-mono ${Math.abs(r.timeDriftMs) > 2000 ? "text-amber-600 font-bold" : ""}`}>
                    {t("drift")}: {r.timeDriftMs >= 0 ? "+" : ""}{Math.abs(r.timeDriftMs) < 1000
                      ? `${Math.round(r.timeDriftMs)}ms`
                      : `${(r.timeDriftMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                <span className={`font-mono ${r.batteryLow ? "text-red-600 font-bold" : ""}`}>
                  {t("bat")}: {r.batteryVoltage.toFixed(2)}V
                </span>
                {r.poweredOff && <span className="text-slate-400">{t("off")}</span>}
                <span>{r.timestamp.toLocaleTimeString(undefined, { hour12: false })}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {connected && results.length === 0 && (
        <p className="text-sm text-slate-500">
          {autoMode
            ? t("autoModeActiveProgramming")
            : t("manualModeProgramming")}
        </p>
      )}
    </div>
  );
}

// ─── Readout panel ───────────────────────────────────────

interface ReadoutResult {
  code: number;
  punchCount: number;
  newPunches: number;
  batteryVoltage: number;
  success: boolean;
  error?: string;
  poweredOff?: boolean;
  cleared?: boolean;
  timestamp: Date;
}

function ReadoutPanel({
  controls,
  onClose,
}: {
  controls: ControlInfo[];
  onClose: () => void;
}) {
  const { t } = useTranslation("controls");
  const { readerStatus, getReaderConnection, connectReader } = useDeviceManager();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReadoutResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [beep, setBeep] = useState(true);
  const [autoMode, setAutoMode] = useState(false);
  const [autoPowerOff, setAutoPowerOff] = useState(false);
  const [autoClear, setAutoClear] = useState(false);

  // Restore direct mode on unmount (navigation away, panel toggle, etc.)
  useEffect(() => {
    return () => {
      try { getReaderConnection().restoreDirectMode().catch(() => {}); } catch {}
    };
  }, [getReaderConnection]);

  const lastReadSerial = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const autoModeRef = useRef(false);
  autoModeRef.current = autoMode;

  const connected = readerStatus === "connected" || readerStatus === "reading";

  const utils = trpc.useUtils();
  const importMutation = trpc.control.importBackupPunches.useMutation({
    onSuccess: () => {
      utils.control.list.invalidate();
    },
  });

  const readStation = useCallback(async (
    reader: ReturnType<typeof getReaderConnection>,
    stationData: { stationCode: number; batteryVoltage: number; serialNo: number; rawData: Uint8Array },
  ) => {
    const code = stationData.stationCode;

    const matchedControl = controls.find((c) => {
      const codes = c.codes.split(";").map((s) => parseInt(s.trim(), 10));
      return codes.includes(code);
    });

    if (!matchedControl) {
      setResults((prev) => [{
        code, punchCount: 0, newPunches: 0,
        batteryVoltage: stationData.batteryVoltage,
        success: false, error: t("controlNotInCompetition", { code }),
        timestamp: new Date(),
      }, ...prev].slice(0, 20));
      return;
    }

    // Read backup memory
    const records = await reader.readBackupMemory();

    let newPunches = 0;
    if (records.length > 0) {
      const punches = records.map((r) => ({
        cardNo: r.cardNo,
        punchTime: r.punchTimeSecs * 10, // seconds → deciseconds for MeOS
        punchDatetime: r.punchDatetime,
        subSecond: r.subSecond,
      }));

      const result = await new Promise<{ count: number }>((resolve, reject) => {
        importMutation.mutate(
          { controlId: matchedControl.id, punches },
          { onSuccess: resolve, onError: reject },
        );
      });
      newPunches = result.count;
    }

    // Clear backup memory if enabled
    let cleared = false;
    if (autoClear) {
      try {
        await reader.clearBackupMemory();
        cleared = true;
      } catch {
        // Ignore clear failure
      }
    }

    // Beep
    if (beep) {
      await reader.beep(1);
    }

    // Power off if enabled
    let poweredOff = false;
    if (autoPowerOff) {
      try {
        await reader.powerOffStation();
        poweredOff = true;
      } catch {
        // Ignore power-off failure
      }
    }

    lastReadSerial.current = stationData.serialNo;

    setResults((prev) => [{
      code,
      punchCount: records.length,
      newPunches,
      batteryVoltage: stationData.batteryVoltage,
      success: true,
      poweredOff,
      cleared,
      timestamp: new Date(),
    }, ...prev].slice(0, 20));
  }, [controls, beep, autoPowerOff, autoClear, importMutation]);

  const handleReadMemory = async () => {
    const reader = getReaderConnection();
    setBusy(true);
    setError(null);

    try {
      const { rawData, ...info } = await reader.readConnectedStation();
      await readStation(reader, { ...info, rawData });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Read failed");
    } finally {
      setBusy(false);
    }
  };

  // Auto-polling loop
  useEffect(() => {
    if (!autoMode || !connected) return;

    let cancelled = false;

    const poll = async () => {
      if (pollingRef.current || cancelled) return;
      pollingRef.current = true;

      try {
        const reader = getReaderConnection();
        const result = await reader.probeConnectedStation();

        if (cancelled || !autoModeRef.current) return;

        if (result && result.serialNo !== lastReadSerial.current) {
          setBusy(true);
          setError(null);
          try {
            await readStation(reader, result);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Read failed");
          } finally {
            setBusy(false);
          }
        }
      } catch {
        // Probe failed — ignore
      } finally {
        pollingRef.current = false;
      }
    };

    poll();
    const interval = setInterval(poll, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [autoMode, connected, getReaderConnection, readStation]);

  const handleClearMemory = async () => {
    setBusy(true);
    setError(null);
    try {
      const reader = getReaderConnection();
      await reader.clearBackupMemory();
      setResults((prev) => [{
        code: 0,
        punchCount: 0,
        newPunches: 0,
        batteryVoltage: 0,
        success: true,
        cleared: true,
        timestamp: new Date(),
      }, ...prev].slice(0, 20));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setBusy(false);
    }
  };

  const handlePowerOff = async () => {
    try {
      const reader = getReaderConnection();
      await reader.powerOffStation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Power off failed");
    }
  };

  const handleClose = async () => {
    try {
      const reader = getReaderConnection();
      await reader.restoreDirectMode();
    } catch {
      // Ignore
    }
    onClose();
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-slate-300"}`} />
          <h3 className="text-sm font-semibold text-slate-800">{t("postCompReadout")}</h3>
        </div>
        <div className="flex items-center gap-2">
          {!connected ? (
            <button
              onClick={() => connectReader()}
              className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 cursor-pointer"
            >
              {t("connectStation")}
            </button>
          ) : (
            <>
              <button
                onClick={handleReadMemory}
                disabled={busy || autoMode}
                className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
              >
                {busy ? t("reading") : t("readMemory")}
              </button>
              <button
                onClick={handleClearMemory}
                disabled={busy || autoMode}
                className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 cursor-pointer"
              >
                {t("clearMemory")}
              </button>
              <button
                onClick={handlePowerOff}
                disabled={busy}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {t("powerOff")}
              </button>
            </>
          )}
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMode}
              onChange={(e) => {
                setAutoMode(e.target.checked);
                if (!e.target.checked) lastReadSerial.current = null;
              }}
              disabled={!connected}
              className="rounded"
            />
            {t("auto")}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoClear}
              onChange={(e) => setAutoClear(e.target.checked)}
              className="rounded"
            />
            {t("clear")}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoPowerOff}
              onChange={(e) => setAutoPowerOff(e.target.checked)}
              className="rounded"
            />
            {t("powerOff")}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={beep}
              onChange={(e) => setBeep(e.target.checked)}
              className="rounded"
            />
            {t("beep")}
          </label>
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-sm bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 cursor-pointer"
          >
            {t("close")}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{error}</div>
      )}

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {results.map((r, i) => (
            <div
              key={i}
              className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                r.success ? "bg-white" : "bg-red-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${r.success ? "bg-green-500" : "bg-red-500"}`} />
                {r.code > 0 && <span className="font-mono font-bold">{r.code}</span>}
                {r.success ? (
                  r.code === 0 && r.cleared ? (
                    <span className="text-orange-600">{t("memoryClearedResult")}</span>
                  ) : (
                    <span className="text-green-700">
                      {t("punchesResult", { total: r.punchCount })}{r.newPunches > 0 ? ` ${t("punchesNew", { new: r.newPunches })}` : ` ${t("punchesAllKnown")}`}
                      {r.punchCount === 0 && ` ${t("punchesEmpty")}`}
                    </span>
                  )
                ) : (
                  <span className="text-red-600">{r.error}</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className={`font-mono ${r.batteryVoltage < 2.5 ? "text-red-600 font-bold" : ""}`}>
                  {t("bat")}: {r.batteryVoltage.toFixed(2)}V
                </span>
                {r.cleared && <span className="text-orange-500">{t("cleared")}</span>}
                {r.poweredOff && <span className="text-slate-400">{t("off")}</span>}
                <span>{r.timestamp.toLocaleTimeString(undefined, { hour12: false })}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {connected && results.length === 0 && (
        <p className="text-sm text-slate-500">
          {autoMode
            ? t("autoModeActiveReadout")
            : t("manualModeReadout")}
        </p>
      )}
    </div>
  );
}

function formatDeciseconds(ds: number): string {
  const totalSeconds = Math.floor(ds / 10);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

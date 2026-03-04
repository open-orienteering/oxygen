import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "../lib/trpc";
import {
  formatMeosTime,
  formatRunningTime,
  parseMeosTime,
  RunnerStatus,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { PunchTable, type PunchTableData } from "./PunchTable";
import { ClubLogo } from "./ClubLogo";
import { SearchableSelect } from "./SearchableSelect";
import { formatEntryDate } from "../lib/format";

interface Props {
  runnerId: number;
  colSpan: number;
}

export function RunnerInlineDetail({ runnerId, colSpan }: Props) {
  const runner = trpc.runner.getById.useQuery({ id: runnerId });
  const readout = trpc.cardReadout.readoutByRunner.useQuery(
    { runnerId },
    { enabled: !!runner.data },
  );
  const utils = trpc.useUtils();

  const invalidateAll = () => {
    utils.runner.list.invalidate();
    utils.runner.getById.invalidate({ id: runnerId });
    utils.competition.dashboard.invalidate();
    utils.lists.startList.invalidate();
    utils.lists.resultList.invalidate();
    utils.cardReadout.readoutByRunner.invalidate({ runnerId });
  };

  const updateMutation = trpc.runner.update.useMutation({
    onSuccess: invalidateAll,
  });

  const addPunchMutation = trpc.cardReadout.addPunch.useMutation({
    onSuccess: invalidateAll,
  });

  const removePunchMutation = trpc.cardReadout.removePunch.useMutation({
    onSuccess: invalidateAll,
  });

  const updatePunchTimeMutation = trpc.cardReadout.updatePunchTime.useMutation({
    onSuccess: invalidateAll,
  });

  // Debounced save
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<number>(0);

  const debouncedSave = useCallback(
    (field: string, value: string | number) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      setSaving(true);
      saveTimeoutRef.current = setTimeout(() => {
        updateMutation.mutate(
          { id: runnerId, data: { [field]: value } },
          {
            onSuccess: () => {
              setSaving(false);
              setLastSaved(Date.now());
            },
            onError: () => setSaving(false),
          },
        );
      }, 600);
    },
    [runnerId, updateMutation],
  );

  if (runner.isLoading) {
    return (
      <tr>
        <td colSpan={colSpan} className="px-4 py-4 bg-blue-50/50">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            Loading...
          </div>
        </td>
      </tr>
    );
  }

  if (!runner.data) return null;

  const r = runner.data;
  const runningTime =
    r.finishTime > 0 && r.startTime > 0 ? r.finishTime - r.startTime : 0;

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="bg-blue-50/60 border-t border-b border-blue-100 px-6 py-4">
          {/* Save indicator */}
          <div className="flex items-center justify-end mb-2 h-5">
            {saving && (
              <span className="text-xs text-blue-500 flex items-center gap-1">
                <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                Saving...
              </span>
            )}
            {!saving && lastSaved > 0 && Date.now() - lastSaved < 3000 && (
              <span className="text-xs text-emerald-600">Saved</span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
            {/* Editable fields */}
            <EditField
              label="Name"
              value={r.name}
              onChange={(v) => debouncedSave("name", v)}
            />
            <SelectField
              label="Class"
              runnerId={runnerId}
              field="classId"
              currentValue={r.classId}
              debouncedSave={debouncedSave}
            />
            <SelectClubField
              label="Club"
              runnerId={runnerId}
              currentValue={r.clubId}
              debouncedSave={debouncedSave}
            />
            <EditField
              label="SI Card"
              value={r.cardNo > 0 ? String(r.cardNo) : ""}
              type="number"
              onChange={(v) => debouncedSave("cardNo", parseInt(v, 10) || 0)}
            />
            <EditField
              label="Start Time"
              value={r.startTime > 0 ? formatMeosTime(r.startTime) : ""}
              placeholder="HH:MM:SS"
              onChange={(v) => debouncedSave("startTime", parseMeosTime(v))}
            />
            <EditField
              label="Finish Time"
              value={r.finishTime > 0 ? formatMeosTime(r.finishTime) : ""}
              placeholder="HH:MM:SS"
              onChange={(v) => debouncedSave("finishTime", parseMeosTime(v))}
            />
            <ReadonlyField
              label="Running Time"
              value={runningTime > 0 ? formatRunningTime(runningTime) : "-"}
              bold
            />
            <div>
              <label className="block text-xs text-slate-500 mb-1">Status</label>
              <StatusSelect
                value={r.status}
                onChange={(v) => debouncedSave("status", v)}
              />
            </div>
            <EditField
              label="Bib"
              value={r.bib}
              onChange={(v) => debouncedSave("bib", v)}
              className="hidden sm:block"
            />
            <EditField
              label="Birth Year"
              value={r.birthYear > 0 ? String(r.birthYear) : ""}
              type="number"
              onChange={(v) =>
                debouncedSave("birthYear", parseInt(v, 10) || 0)
              }
              className="hidden sm:block"
            />
            <div className="hidden sm:block">
              <label className="block text-xs text-slate-500 mb-1">Sex</label>
              <SexSelect
                value={r.sex}
                onChange={(v) => debouncedSave("sex", v)}
              />
            </div>
            <EditField
              label="Nationality"
              value={r.nationality}
              onChange={(v) => debouncedSave("nationality", v)}
              placeholder="e.g. SWE"
              className="hidden sm:block"
            />
            <EditField
              label="Phone"
              value={r.phone}
              onChange={(v) => debouncedSave("phone", v)}
              className="hidden sm:block"
            />
            {r.entryDate > 0 && (
              <ReadonlyField
                label="Entry Date"
                value={formatEntryDate(r.entryDate)}
              />
            )}
          </div>

          {/* Punch data (editable) */}
          {readout.data?.controls && readout.data.controls.length > 0 && (
            <div className="mt-4 pt-4 border-t border-blue-100">
              <PunchTable
                data={{
                  controls: readout.data.controls,
                  timing: readout.data.timing,
                  course: readout.data.course,
                  extraPunches: readout.data.extraPunches,
                  missingControls: readout.data.missingControls,
                }}
                compact
                editable
                onAddPunch={(controlCode, time) => {
                  addPunchMutation.mutate({
                    cardNo: r.cardNo,
                    controlCode,
                    time,
                  });
                }}
                onRemovePunch={(punchId) => {
                  removePunchMutation.mutate({ punchId });
                }}
                onUpdatePunchTime={(punchId, newTime) => {
                  updatePunchTimeMutation.mutate({ punchId, time: newTime });
                }}
                onUpdateStartTime={(time) => {
                  updateMutation.mutate(
                    { id: runnerId, data: { startTime: time } },
                    { onSuccess: invalidateAll },
                  );
                }}
                onUpdateFinishTime={(time) => {
                  updateMutation.mutate(
                    { id: runnerId, data: { finishTime: time } },
                    { onSuccess: invalidateAll },
                  );
                }}
              />
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function EditField({
  label,
  value,
  type = "text",
  placeholder,
  onChange,
  className = "",
}: {
  label: string;
  value: string;
  type?: string;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(value);

  // Sync external changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (newVal: string) => {
    setLocalValue(newVal);
    onChange(newVal);
  };

  return (
    <div className={className}>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <input
        type={type}
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
      />
    </div>
  );
}

function ReadonlyField({
  label,
  value,
  bold,
  badge,
}: {
  label: string;
  value?: string;
  bold?: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      {badge ? (
        <div className="mt-1">{badge}</div>
      ) : (
        <div
          className={`px-2 py-1.5 text-sm tabular-nums ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}
        >
          {value}
        </div>
      )}
    </div>
  );
}

function SexSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
    >
      <option value="">-</option>
      <option value="M">Male</option>
      <option value="F">Female</option>
    </select>
  );
}

function SelectField({
  label,
  runnerId,
  field,
  currentValue,
  debouncedSave,
}: {
  label: string;
  runnerId: number;
  field: string;
  currentValue: number;
  debouncedSave: (field: string, value: number) => void;
}) {
  const dashboard = trpc.competition.dashboard.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => debouncedSave(field, Number(v))}
        placeholder="-"
        searchPlaceholder="Search classes..."
        options={[
          { value: 0, label: "-" },
          ...(dashboard.data?.classes.map((c) => ({
            value: c.id,
            label: c.name,
          })) ?? []),
        ]}
      />
    </div>
  );
}

/** Status options for the dropdown, ordered by typical usage */
const STATUS_OPTIONS: { value: RunnerStatusValue; label: string; badgeClass: string }[] = [
  { value: RunnerStatus.Unknown, label: "Unknown (no result)", badgeClass: "bg-slate-100 text-slate-500" },
  { value: RunnerStatus.OK, label: "OK", badgeClass: "bg-green-100 text-green-800" },
  { value: RunnerStatus.MissingPunch, label: "MP — Missing Punch", badgeClass: "bg-red-100 text-red-800" },
  { value: RunnerStatus.DNF, label: "DNF — Did Not Finish", badgeClass: "bg-orange-100 text-orange-800" },
  { value: RunnerStatus.DNS, label: "DNS — Did Not Start", badgeClass: "bg-slate-100 text-slate-600" },
  { value: RunnerStatus.DQ, label: "DQ — Disqualified", badgeClass: "bg-red-100 text-red-800" },
  { value: RunnerStatus.OverMaxTime, label: "Over Max Time", badgeClass: "bg-orange-100 text-orange-800" },
  { value: RunnerStatus.NoTiming, label: "No Timing", badgeClass: "bg-slate-100 text-slate-500" },
  { value: RunnerStatus.OutOfCompetition, label: "Out of Competition", badgeClass: "bg-slate-100 text-slate-500" },
  { value: RunnerStatus.Cancel, label: "Cancelled", badgeClass: "bg-slate-100 text-slate-500" },
  { value: RunnerStatus.NotCompeting, label: "Not Competing", badgeClass: "bg-slate-100 text-slate-500" },
];

function StatusBadgeInline({ badgeClass, label }: { badgeClass: string; label: string }) {
  // Extract the short code (e.g. "OK", "MP", "DNF") from the label
  const short = label.includes("—") ? label.split("—")[0].trim() : label.split("(")[0].trim();
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badgeClass}`}>
      {short}
    </span>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <SearchableSelect
      value={value}
      onChange={(v) => onChange(Number(v))}
      placeholder="Select status..."
      searchPlaceholder="Search statuses..."
      options={STATUS_OPTIONS.map((opt) => ({
        value: opt.value,
        label: opt.label,
        icon: <StatusBadgeInline badgeClass={opt.badgeClass} label={opt.label} />,
      }))}
    />
  );
}

function SelectClubField({
  label,
  runnerId,
  currentValue,
  debouncedSave,
}: {
  label: string;
  runnerId: number;
  currentValue: number;
  debouncedSave: (field: string, value: number) => void;
}) {
  const clubs = trpc.competition.clubs.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => debouncedSave("clubId", Number(v))}
        placeholder="- None -"
        searchPlaceholder="Search clubs..."
        options={[
          { value: 0, label: "- None -" },
          ...(clubs.data?.map((c) => ({
            value: c.id,
            label: c.name,
            icon: <ClubLogo clubId={c.id} size="sm" />,
          })) ?? []),
        ]}
      />
    </div>
  );
}

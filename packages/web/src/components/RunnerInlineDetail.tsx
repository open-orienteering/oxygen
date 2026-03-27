import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import {
  formatMeosTime,
  formatRunningTime,
  parseMeosTime,
  RunnerStatus,
  TransferFlags,
  hasTransferFlag,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { PunchTable, type PunchTableData } from "./PunchTable";
import { MapPanel } from "./MapPanel";
import { ClubLogo } from "./ClubLogo";
import { SearchableSelect } from "./SearchableSelect";
import { formatEntryDate } from "../lib/format";
import { CardTypeBadge } from "./CardTypeBadge";
import { getCardType } from "../lib/si-protocol";

function payModeLabel(payMode: number, t: (key: string) => string): string {
  const labels: Record<number, string> = {
    1: t("payModeInvoice"), 2: t("payModeOnSite"),
    3: t("payModeCard"), 4: t("payModeSwish"), 5: t("payModeCash"),
  };
  return labels[payMode] ?? "-";
}

interface Props {
  runnerId: number;
  colSpan: number;
}

export function RunnerInlineDetail({ runnerId, colSpan }: Props) {
  const { t } = useTranslation("runners");
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

  const setCardReturnedMutation = trpc.runner.setCardReturned.useMutation({
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
            {t("loading")}
          </div>
        </td>
      </tr>
    );
  }

  if (!runner.data) return null;

  const r = runner.data;
  const runningTime =
    r.finishTime > 0 && r.startTime > 0 ? r.finishTime - r.startTime : 0;

  const mispunchMapInfo = (() => {
    const d = readout.data;
    if (!d?.course) return null;
    if (d.missingControls.length === 0 && d.extraPunches.length === 0) return null;
    const punchStatusByCode: Record<string, "ok" | "missing" | "extra"> = {};
    for (const c of d.controls) punchStatusByCode[String(c.controlCode)] = c.status as "ok" | "missing" | "extra";
    for (const ep of d.extraPunches) punchStatusByCode[String(ep.controlCode)] = "extra";
    const focusControlCodes = [
      ...d.controls.filter((c) => c.status === "missing").map((c) => String(c.controlCode)),
      ...d.extraPunches.map((ep) => String(ep.controlCode)),
    ];
    return { courseName: d.course.name, punchStatusByCode, focusControlCodes };
  })();

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="bg-blue-50/60 border-t border-b border-blue-100 px-6 py-4">
          {/* Save indicator */}
          <div className="flex items-center justify-end mb-2 h-5">
            {saving && (
              <span className="text-xs text-blue-500 flex items-center gap-1">
                <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                {t("saving")}
              </span>
            )}
            {!saving && lastSaved > 0 && Date.now() - lastSaved < 3000 && (
              <span className="text-xs text-emerald-600">{t("saved")}</span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
            {/* Editable fields */}
            <EditField
              label={t("name")}
              value={r.name}
              onChange={(v) => debouncedSave("name", v)}
            />
            <SelectField
              label={t("class")}
              runnerId={runnerId}
              field="classId"
              currentValue={r.classId}
              debouncedSave={debouncedSave}
            />
            <SelectClubField
              label={t("club")}
              runnerId={runnerId}
              currentValue={r.clubId}
              debouncedSave={debouncedSave}
            />
            <div>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                {t("siCard")}
                {r.cardNo > 0 && <CardTypeBadge type={getCardType(r.cardNo)} />}
              </label>
              <EditField
                label=""
                value={r.cardNo > 0 ? String(r.cardNo) : ""}
                type="number"
                onChange={(v) => debouncedSave("cardNo", parseInt(v, 10) || 0)}
              />
            </div>
            <EditField
              label={t("startTime")}
              value={r.startTime > 0 ? formatMeosTime(r.startTime) : ""}
              placeholder="HH:MM:SS"
              onChange={(v) => debouncedSave("startTime", parseMeosTime(v))}
            />
            <EditField
              label={t("finishTime")}
              value={r.finishTime > 0 ? formatMeosTime(r.finishTime) : ""}
              placeholder="HH:MM:SS"
              onChange={(v) => debouncedSave("finishTime", parseMeosTime(v))}
            />
            <ReadonlyField
              label={t("runningTime")}
              value={runningTime > 0 ? formatRunningTime(runningTime) : "-"}
              bold
            />
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("status")}</label>
              <StatusSelect
                value={r.status}
                onChange={(v) => debouncedSave("status", v)}
              />
              {r.transferFlags > 0 && (
                <div className="flex gap-1 mt-1">
                  {hasTransferFlag(r.transferFlags, TransferFlags.FlagOutsideCompetition) && (
                    <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">{t("flagOC")}</span>
                  )}
                  {hasTransferFlag(r.transferFlags, TransferFlags.FlagNoTiming) && (
                    <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">{t("flagNT")}</span>
                  )}
                  {hasTransferFlag(r.transferFlags, TransferFlags.FlagPayBeforeResult) && (
                    <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">{t("flagPayBefore")}</span>
                  )}
                </div>
              )}
            </div>
            <EditField
              label={t("bib")}
              value={r.bib}
              onChange={(v) => debouncedSave("bib", v)}
              className="hidden sm:block"
            />
            <EditField
              label={t("birthYear")}
              value={r.birthYear > 0 ? String(r.birthYear) : ""}
              type="number"
              onChange={(v) =>
                debouncedSave("birthYear", parseInt(v, 10) || 0)
              }
              className="hidden sm:block"
            />
            <div className="hidden sm:block">
              <label className="block text-xs text-slate-500 mb-1">{t("sex")}</label>
              <SexSelect
                value={r.sex}
                onChange={(v) => debouncedSave("sex", v)}
              />
            </div>
            <EditField
              label={t("nationality")}
              value={r.nationality}
              onChange={(v) => debouncedSave("nationality", v)}
              placeholder="e.g. SWE"
              className="hidden sm:block"
            />
            <EditField
              label={t("phone")}
              value={r.phone}
              onChange={(v) => debouncedSave("phone", v)}
              className="hidden sm:block"
            />
            {r.entryDate > 0 && (
              <ReadonlyField
                label={t("entryDate")}
                value={formatEntryDate(r.entryDate)}
              />
            )}
            {(r.fee > 0 || r.paid > 0) && (
              <>
                <ReadonlyField label={t("fee")} value={`${r.fee} kr`} />
                <ReadonlyField label={t("paid")} value={`${r.paid} kr`} />
                {r.payMode > 0 && (
                  <ReadonlyField label={t("paymentMethod")} value={payModeLabel(r.payMode, t as (key: string) => string)} />
                )}
              </>
            )}
            {(r.cardFee ?? 0) !== 0 && (
              <div className="flex items-center justify-between py-1.5 border-b border-blue-100">
                <span className="text-xs text-slate-500 font-medium">{t("rentalCard")}</span>
                <div className="flex items-center gap-2">
                  {r.cardFee > 0 && (
                    <span className="text-xs font-semibold text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-0.5">
                      {r.cardFee} kr
                    </span>
                  )}
                  {r.cardReturned ? (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5 font-medium">
                      ✓ {t("cardReturned")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 font-medium">
                      ⚠ {t("rentalCard")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setCardReturnedMutation.mutate({ runnerId, returned: !r.cardReturned })}
                    disabled={setCardReturnedMutation.isPending}
                    data-testid={r.cardReturned ? "undo-card-returned" : "mark-card-returned"}
                    className={`text-xs px-2 py-0.5 rounded border cursor-pointer transition-colors ${
                      r.cardReturned
                        ? "border-slate-300 text-slate-500 hover:bg-slate-50"
                        : "border-emerald-400 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                    }`}
                  >
                    {r.cardReturned ? t("markNotReturned") : t("markReturned")}
                  </button>
                </div>
              </div>
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

              {/* Mispunch map — shown when there are missing or extra controls */}
              {mispunchMapInfo && (
                <div className="mt-4 pt-4 border-t border-blue-100">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-slate-600">{t("courseMap")}</span>
                    <span className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="7" r="5.5" stroke="#ef4444" strokeWidth="1.5" />
                          <line x1="4" y1="4" x2="10" y2="10" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                          <line x1="10" y1="4" x2="4" y2="10" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        {t("missing")}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="7" r="5.5" stroke="#f97316" strokeWidth="1.5" />
                        </svg>
                        {t("extraPunch")}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="7" r="5.5" stroke="#059669" strokeWidth="1.5" />
                        </svg>
                        {t("correct")}
                      </span>
                    </span>
                  </div>
                  <MapPanel
                    highlightCourseName={mispunchMapInfo.courseName}
                    filterMode="course"
                    height="300px"
                    fitToControls
                    punchStatusByCode={mispunchMapInfo.punchStatusByCode}
                    focusControlCodes={mispunchMapInfo.focusControlCodes}
                  />
                </div>
              )}
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
      {label && <label className="block text-xs text-slate-500 mb-1">{label}</label>}
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
  const { t } = useTranslation("runners");
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
    >
      <option value="">-</option>
      <option value="M">{t("male")}</option>
      <option value="F">{t("female")}</option>
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
  const { t } = useTranslation("runners");
  const dashboard = trpc.competition.dashboard.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => debouncedSave(field, Number(v))}
        placeholder="-"
        searchPlaceholder={t("searchClasses")}
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
function getStatusOptions(t: (key: string) => string): { value: RunnerStatusValue; label: string; badgeClass: string }[] {
  return [
    { value: RunnerStatus.Unknown, label: t("statusUnknown"), badgeClass: "bg-slate-100 text-slate-500" },
    { value: RunnerStatus.OK, label: "OK", badgeClass: "bg-green-100 text-green-800" },
    { value: RunnerStatus.MissingPunch, label: t("statusMP"), badgeClass: "bg-red-100 text-red-800" },
    { value: RunnerStatus.DNF, label: t("statusDNF"), badgeClass: "bg-orange-100 text-orange-800" },
    { value: RunnerStatus.DNS, label: t("statusDNS"), badgeClass: "bg-slate-100 text-slate-600" },
    { value: RunnerStatus.DQ, label: t("statusDQ"), badgeClass: "bg-red-100 text-red-800" },
    { value: RunnerStatus.OverMaxTime, label: t("statusOverMaxTime"), badgeClass: "bg-orange-100 text-orange-800" },
    { value: RunnerStatus.NoTiming, label: t("statusNoTiming"), badgeClass: "bg-slate-100 text-slate-500" },
    { value: RunnerStatus.OutOfCompetition, label: t("statusOutOfCompetition"), badgeClass: "bg-slate-100 text-slate-500" },
    { value: RunnerStatus.Cancel, label: t("statusCancelled"), badgeClass: "bg-slate-100 text-slate-500" },
    { value: RunnerStatus.NotCompeting, label: t("statusNotCompeting"), badgeClass: "bg-slate-100 text-slate-500" },
  ];
}

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
  const { t } = useTranslation("runners");
  const statusOptions = getStatusOptions(t as (key: string) => string);
  return (
    <SearchableSelect
      value={value}
      onChange={(v) => onChange(Number(v))}
      placeholder={t("selectStatus")}
      searchPlaceholder={t("searchStatuses")}
      options={statusOptions.map((opt) => ({
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
  const { t } = useTranslation("runners");
  const clubs = trpc.competition.clubs.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => debouncedSave("clubId", Number(v))}
        placeholder={t("noClub")}
        searchPlaceholder={t("searchClubs")}
        options={[
          { value: 0, label: t("noClub") },
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

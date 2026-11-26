import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import {
  formatMeosTime,
  formatRunningTime,
  parseClockTime,
  RunnerStatus,
  TransferFlags,
  hasTransferFlag,
  type RunnerStatusValue,
  type RunnerEventorDiff,
} from "@oxygen/shared";
import { EventorMarker } from "./EventorMarker";
import { PunchTable } from "./PunchTable";
import { OtherVariantBanner } from "./OtherVariantBanner";
import { ClubLogo } from "./ClubLogo";
import { SearchableSelect } from "./SearchableSelect";
import { formatEntryDate } from "../lib/format";
import { CardTypeBadge } from "./CardTypeBadge";
import { getCardType } from "../lib/si-protocol";
import {
  isSettled,
  mergePendingEdits,
  saveErrorText,
  shouldSyncField,
  validateRunnerEdits,
  type PendingEdits,
  type RunnerEditError,
  type RunnerEditValue,
} from "../lib/runner-edits";

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
    utils.class.detail.invalidate();
    utils.runner.getById.invalidate({ id: runnerId });
    utils.competition.dashboard.invalidate();
    utils.lists.startList.invalidate();
    utils.lists.resultList.invalidate();
    utils.cardReadout.readoutByRunner.invalidate({ runnerId });
  };

  const useEventorValueMutation = trpc.runner.useEventorValue.useMutation({
    onSuccess: invalidateAll,
  });
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

  // Pending edits (WEB-07): every field edited before the save fires goes in
  // one map behind one 600 ms timer, so a fast tab from name to card number
  // sends both. Blur, Enter, a select and closing the row flush at once. One
  // save is in flight at a time; edits made meanwhile go in the next one.
  const pendingRef = useRef<PendingEdits>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<number>(0);
  // A refused save (WEB-08) stays on screen until the next successful one.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, RunnerEditError>>({});
  // Bumped per field when the server refuses it: the input shows the stored value again.
  const [resetEpochs, setResetEpochs] = useState<Record<string, number>>({});

  type UpdateData = NonNullable<Parameters<typeof updateMutation.mutate>[0]["data"]>;

  const flush = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) return; // onSettled sends what queued meanwhile
    const { data, errors } = validateRunnerEdits(pendingRef.current);
    pendingRef.current = {};
    if (Object.keys(errors).length > 0) setFieldErrors((prev) => ({ ...prev, ...errors }));
    const fields = Object.keys(data);
    if (fields.length === 0) {
      setSaving(false);
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    // `mutateAsync`, not per-call callbacks: its promise settles even after
    // the row closed, so the close-time save can wait for it (no reordering).
    const p = updateMutation
      .mutateAsync({ id: runnerId, data: data as UpdateData })
      .then(
        () => {
          setSaveError(null);
          setLastSaved(Date.now());
        },
        (err: unknown) => {
          setSaveError(saveErrorText(err instanceof Error ? err.message : String(err)));
          setLastSaved(0);
          // Back to the stored value, except where newer text is already
          // queued: that edit goes out next and must stay on screen.
          setResetEpochs((prev) => {
            const next = { ...prev };
            for (const f of fields) if (!(f in pendingRef.current)) next[f] = (next[f] ?? 0) + 1;
            return next;
          });
          utils.runner.getById.invalidate({ id: runnerId });
        },
      )
      .finally(() => {
        inFlightRef.current = false;
        if (inFlightPromiseRef.current === p) inFlightPromiseRef.current = null;
        if (timerRef.current) return; // still typing: the timer flushes
        if (Object.keys(pendingRef.current).length > 0) flushRef.current();
        else setSaving(false);
      });
    inFlightPromiseRef.current = p;
  };
  const flushRef = useRef(flush);
  useLayoutEffect(() => {
    flushRef.current = flush;
  });

  /** Queue one field edit; `immediate` (selects, committed times) saves now. */
  const edit = (field: string, value: RunnerEditValue, immediate = false) => {
    pendingRef.current = mergePendingEdits(pendingRef.current, field, value);
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setSaving(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (immediate) flushRef.current();
    else
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushRef.current();
      }, 600);
  };
  const flushNow = () => flushRef.current();

  // Closing the row (or leaving the page) must not drop a pending edit. The
  // component is gone, so the save goes through the client directly; its
  // result can no longer be shown in this pane.
  const unmountFlush = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const { data } = validateRunnerEdits(pendingRef.current);
    pendingRef.current = {};
    if (Object.keys(data).length === 0) return;
    // After the save still in flight, so an older value cannot land last.
    (inFlightPromiseRef.current ?? Promise.resolve())
      .then(() => utils.client.runner.update.mutate({ id: runnerId, data: data as UpdateData }))
      .then(invalidateAll, (err: unknown) => console.error("Runner edit not saved on close:", err));
  };
  const unmountFlushRef = useRef(unmountFlush);
  useLayoutEffect(() => {
    unmountFlushRef.current = unmountFlush;
  });
  useEffect(() => {
    const ref = unmountFlushRef;
    return () => ref.current();
  }, []);

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
  const diffByField = new Map((r.eventorDiff ?? []).map((d) => [d.field, d]));
  const marker = (field: RunnerEventorDiff["field"]) => {
    const d = diffByField.get(field);
    if (!d) return null;
    return (
      <EventorMarker
        diff={d}
        pending={useEventorValueMutation.isPending}
        error={
          useEventorValueMutation.isError && useEventorValueMutation.variables?.field === d.field
            ? useEventorValueMutation.error.message
            : null
        }
        onUse={() => useEventorValueMutation.mutate({ runnerId, field })}
      />
    );
  };
  // The three punch edits share one error line above the table: the latest
  // punch edit's outcome, so a later success clears an earlier failure.
  const punchError = [addPunchMutation, removePunchMutation, updatePunchTimeMutation]
    .filter((m) => m.submittedAt > 0)
    .sort((a, b) => b.submittedAt - a.submittedAt)[0]?.error;
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
                {t("saving")}
              </span>
            )}
            {!saving && !saveError && lastSaved > 0 && Date.now() - lastSaved < 3000 && (
              <span className="text-xs text-emerald-600" data-testid="runner-saved">{t("saved")}</span>
            )}
          </div>

          {r.goneFromEventor && (
            <div
              data-testid="eventor-gone-banner"
              className="mb-3 px-3 py-1.5 rounded-md bg-sky-50 border border-sky-200 text-xs text-sky-800"
            >
              {t(r.status === RunnerStatus.Cancel ? "eventorGoneCancelledBanner" : "eventorGoneBanner")}
            </div>
          )}

          {saveError && (
            <p className="mb-2 text-xs text-red-600" role="alert" data-testid="runner-save-error">
              {saveError}
            </p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
            {/* Editable fields */}
            <div>
              <EditField
                label={t("name")}
                testId="runner-name"
                value={r.name}
                onChange={(v) => edit("name", v)}
                onCommit={flushNow}
                resetEpoch={resetEpochs.name}
                error={fieldErrors.name && t(fieldErrors.name)}
              />
              {marker("name")}
            </div>
            <div>
              <SelectField
                label={t("class")}
                runnerId={runnerId}
                field="classId"
                currentValue={r.classId}
                onSave={(field, v) => edit(field, v, true)}
              />
              {fieldErrors.classId && (
                <p className="text-xs text-red-600 mt-0.5">{t(fieldErrors.classId)}</p>
              )}
              {marker("classId")}
            </div>
            <VariantSelectField
              classId={r.classId}
              courseId={r.courseId}
              onChange={(courseId) => edit("courseId", courseId, true)}
            />
            <div>
              <SelectClubField
                label={t("club")}
                runnerId={runnerId}
                currentValue={r.clubId}
                onSave={(field, v) => edit(field, v, true)}
              />
              {marker("club")}
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                {t("siCard")}
                {r.cardNo > 0 && <CardTypeBadge type={getCardType(r.cardNo)} />}
              </label>
              <EditField
                label=""
                testId="runner-card"
                value={r.cardNo > 0 ? String(r.cardNo) : ""}
                type="number"
                onChange={(v) => edit("cardNo", parseInt(v, 10) || 0)}
                onCommit={flushNow}
                resetEpoch={resetEpochs.cardNo}
                error={fieldErrors.cardNo && t(fieldErrors.cardNo)}
              />
              {marker("cardNo")}
            </div>
            <TimeField
              label={t("startTime")}
              testId="runner-start-time"
              value={r.startTime}
              invalidText={t("invalidClockTime")}
              onCommit={(ds) => edit("startTime", ds, true)}
              resetEpoch={resetEpochs.startTime}
            />
            <TimeField
              label={t("finishTime")}
              testId="runner-finish-time"
              value={r.finishTime}
              invalidText={t("invalidClockTime")}
              onCommit={(ds) => edit("finishTime", ds, true)}
              resetEpoch={resetEpochs.finishTime}
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
                onChange={(v) => edit("status", v, true)}
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
              testId="runner-bib"
              value={r.bib}
              onChange={(v) => edit("bib", v)}
              onCommit={flushNow}
              resetEpoch={resetEpochs.bib}
              className="hidden sm:block"
            />
            <div className="hidden sm:block">
              <EditField
                label={t("birthYear")}
                value={r.birthYear > 0 ? String(r.birthYear) : ""}
                type="number"
                onChange={(v) => edit("birthYear", parseInt(v, 10) || 0)}
                onCommit={flushNow}
                resetEpoch={resetEpochs.birthYear}
              />
              {marker("birthYear")}
            </div>
            <div className="hidden sm:block">
              <label className="block text-xs text-slate-500 mb-1">{t("sex")}</label>
              <SexSelect
                value={r.sex}
                onChange={(v) => edit("sex", v, true)}
              />
              {marker("sex")}
            </div>
            <div className="hidden sm:block">
              <EditField
                label={t("nationality")}
                value={r.nationality}
                onChange={(v) => edit("nationality", v)}
                onCommit={flushNow}
                resetEpoch={resetEpochs.nationality}
                placeholder="e.g. SWE"
              />
              {marker("nationality")}
            </div>
            <EditField
              label={t("phone")}
              value={r.phone}
              onChange={(v) => edit("phone", v)}
              onCommit={flushNow}
              resetEpoch={resetEpochs.phone}
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
                {setCardReturnedMutation.error && (
                  <p className="text-xs text-red-600" role="alert" data-testid="card-returned-error">
                    {saveErrorText(setCardReturnedMutation.error.message)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Red exit (F6c): the punches match another variant fully */}
          {readout.data && readout.data.otherVariantMatches.length > 0 && (
            <div className="mt-4">
              <OtherVariantBanner
                matches={readout.data.otherVariantMatches}
                runnerId={runnerId}
                onAccepted={invalidateAll}
              />
            </div>
          )}

          {/* Punch data (editable) */}
          {readout.data?.controls && readout.data.controls.length > 0 && (
            <div className="mt-4 pt-4 border-t border-blue-100">
              {punchError && (
                <p className="mb-2 text-xs text-red-600" role="alert" data-testid="runner-punch-error">
                  {saveErrorText(punchError.message)}
                </p>
              )}
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
                  removePunchMutation.mutate({ punchId: String(punchId) });
                }}
                onUpdatePunchTime={(punchId, newTime) => {
                  updatePunchTimeMutation.mutate({
                    punchId: String(punchId),
                    time: newTime,
                  });
                }}
                onUpdateStartTime={(time) => edit("startTime", time, true)}
                onUpdateFinishTime={(time) => edit("finishTime", time, true)}
              />

              {/* The full per-runner map (course + punch status colours
                  + GPS track) is rendered at the page level via
                  `<MapSlot><RunnerMapPreview ... /></MapSlot>` and
                  reflects the expanded runner automatically. */}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * A text or number field of the runner editor (WEB-07, WEB-08). Typing
 * queues the edit (`onChange`); blur and Enter save it at once (`onCommit`).
 * The stored value from props is taken over only while the field has no
 * focus and no text that is not yet stored, so the refetch after an earlier
 * save cannot rewrite what is being typed. `resetEpoch` changes when the
 * server refused the field: the input shows the stored value again.
 */
function EditField({
  label,
  value,
  type = "text",
  placeholder,
  onChange,
  onCommit,
  resetEpoch = 0,
  error,
  testId,
  className = "",
}: {
  label: string;
  value: string;
  type?: "text" | "number";
  placeholder?: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  resetEpoch?: number;
  error?: string;
  testId?: string;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(value);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const valueRef = useRef(value);
  useLayoutEffect(() => {
    valueRef.current = value;
  });

  // The stored value caught up with the text: nothing is pending any more.
  useEffect(() => {
    if (dirty && isSettled(localValue, value, type)) setDirty(false);
  }, [dirty, localValue, value, type]);

  useEffect(() => {
    if (shouldSyncField({ focused, dirty })) setLocalValue(value);
  }, [value, focused, dirty]);

  // A refused save: back to the stored value, focused or not.
  useEffect(() => {
    if (resetEpoch === 0) return;
    setLocalValue(valueRef.current);
    setDirty(false);
  }, [resetEpoch]);

  return (
    <div className={className}>
      {label && <label className="block text-xs text-slate-500 mb-1">{label}</label>}
      <input
        type={type}
        value={localValue}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setLocalValue(e.target.value);
          setDirty(true);
          onChange(e.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        placeholder={placeholder}
        className={`w-full px-2 py-1.5 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:border-transparent ${
          error ? "border-red-400 focus:ring-red-400" : "border-slate-200 focus:ring-blue-400"
        }`}
      />
      {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
    </div>
  );
}

/**
 * A clock-time field (RES-13): saved on blur or Enter, never per keystroke,
 * and only when it parses (`H:MM`, `H:MM:SS`, `HH.MM.SS`, `HHMMSS`). An
 * empty field clears the time; anything else is shown in red and not saved,
 * so a half-typed "10:4" can no longer be stored as 00:10:04.
 */
export function TimeField({
  label,
  value,
  onCommit,
  invalidText,
  testId,
  resetEpoch = 0,
}: {
  label: string;
  /** Absolute deciseconds; 0 = no time. */
  value: number;
  onCommit: (ds: number) => void;
  invalidText: string;
  testId?: string;
  /** Changes when the server refused this time: show the stored one again. */
  resetEpoch?: number;
}) {
  const shown = value > 0 ? formatMeosTime(value) : "";
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Follow the stored value, but never rewrite the field while it is edited.
  useEffect(() => {
    if (!editing) {
      setText(shown);
      setInvalid(false);
    }
  }, [shown, editing]);

  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  });
  useEffect(() => {
    if (resetEpoch === 0) return;
    setText(shownRef.current);
    setEditing(false);
    setInvalid(false);
  }, [resetEpoch]);

  const commit = () => {
    const trimmed = text.trim();
    // Tabbing through changes nothing (a stored time with tenths would
    // otherwise be truncated to whole seconds and journaled).
    if (trimmed === shown) {
      setEditing(false);
      setInvalid(false);
      return;
    }
    const parsed = trimmed === "" ? 0 : parseClockTime(trimmed);
    // 00:00:00 is "no time" in the API: only an empty field clears.
    const ds = trimmed !== "" && parsed === 0 ? null : parsed;
    if (ds === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setEditing(false);
    if (ds !== value) onCommit(ds);
    else setText(shown);
  };

  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <input
        type="text"
        value={text}
        data-testid={testId}
        aria-invalid={invalid || undefined}
        placeholder="HH:MM:SS"
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setEditing(false);
            setText(shown);
            setInvalid(false);
          }
        }}
        className={`w-full px-2 py-1.5 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:border-transparent tabular-nums ${
          invalid ? "border-red-400 focus:ring-red-400" : "border-slate-200 focus:ring-blue-400"
        }`}
      />
      {invalid && <p className="text-xs text-red-600 mt-0.5">{invalidText}</p>}
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
  field,
  currentValue,
  onSave,
}: {
  label: string;
  runnerId: number;
  field: string;
  currentValue: number;
  onSave: (field: string, value: number) => void;
}) {
  const { t } = useTranslation("runners");
  const dashboard = trpc.competition.dashboard.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => {
          if (Number(v) !== currentValue) onSave(field, Number(v));
        }}
        placeholder="-"
        searchPlaceholder={t("searchClasses")}
        options={[
          // A runner needs a class (WEB-08): "-" only while none is set.
          ...(currentValue > 0 ? [] : [{ value: 0, label: "-" }]),
          ...(dashboard.data?.classes.map((c) => ({
            value: c.id,
            label: c.name,
          })) ?? []),
        ]}
      />
    </div>
  );
}

/**
 * The runner's variant in a class on a forked course (F6b): one of the
 * class's pooled variants, pre-set before the race. Hidden when the class
 * has no variants.
 */
function VariantSelectField({
  classId,
  courseId,
  onChange,
}: {
  classId: number;
  courseId: number;
  onChange: (courseId: number) => void;
}) {
  const { t } = useTranslation("runners");
  const detail = trpc.class.detail.useQuery({ id: classId }, { enabled: classId > 0 });
  const variants = detail.data?.variants ?? [];
  if (classId <= 0 || variants.length === 0) return null;
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{t("variant")}</label>
      <select
        value={variants.some((v) => v.courseId === courseId) ? courseId : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid="runner-variant"
        className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
      >
        {!variants.some((v) => v.courseId === courseId) && <option value="">-</option>}
        {variants.map((v) => (
          <option key={v.courseId} value={v.courseId}>
            {v.variantKey}
          </option>
        ))}
      </select>
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
  currentValue,
  onSave,
}: {
  label: string;
  runnerId: number;
  currentValue: number;
  onSave: (field: string, value: number) => void;
}) {
  const { t } = useTranslation("runners");
  const clubs = trpc.competition.clubs.useQuery();
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <SearchableSelect
        value={currentValue}
        onChange={(v) => onSave("clubId", Number(v))}
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

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMeosTime, formatRunningTime, parseMeosTime, type ControlMatch as SharedControlMatch } from "@oxygen/shared";

// PunchTable consumes the canonical ControlMatch shape from @oxygen/shared,
// which now carries `positionMode` (required / skipped / noTiming) and
// `expectedCodes` for multi-code support. We allow `positionMode` to be
// optional in the props to keep older callers (tests / fixtures that
// haven't been updated) compiling without changes — they fall through to
// "required" rendering, identical to the legacy three-status behaviour.
type ControlMatch = Omit<SharedControlMatch, "positionMode" | "expectedCodes"> & {
  positionMode?: SharedControlMatch["positionMode"];
  expectedCodes?: SharedControlMatch["expectedCodes"];
};

interface ExtraPunch {
  controlCode: number;
  time: number;
  source: "card" | "free";
  freePunchId?: number;
}

export interface PunchTableData {
  controls: ControlMatch[];
  timing: {
    startTime: number;
    finishTime: number;
    runningTime: number;
    /**
     * Raw `finishTime - startTime` before NoTiming/BadNoTiming legs are
     * deducted. When this differs from `runningTime`, the table shows
     * both numbers in the header so admins can see what was excluded.
     */
    rawRunningTime?: number;
    /** Sum of deciseconds deducted from `rawRunningTime`. */
    runningTimeAdjustment?: number;
  };
  course: {
    name: string;
    length: number;
    controlCount: number;
    /** Required-position count for the X/Y "controlsOk" stat header. */
    requiredControlCount?: number;
  } | null;
  extraPunches: ExtraPunch[];
  missingControls: number[];
}

interface PunchTableProps {
  data: PunchTableData;
  editable?: boolean;
  compact?: boolean;
  dark?: boolean;
  onAddPunch?: (controlCode: number, time: number) => void;
  onRemovePunch?: (punchId: number) => void;
  onUpdatePunchTime?: (punchId: number, newTime: number) => void;
  onUpdateStartTime?: (time: number) => void;
  onUpdateFinishTime?: (time: number) => void;
}

// ─── Merged row type for inline extra-punch view ─────────────

type MergedRow =
  | { kind: "control"; ctrl: ControlMatch; idx: number }
  | { kind: "extra"; punch: ExtraPunch; extraIdx: number };

function buildInlineRows(controls: ControlMatch[], extraPunches: ExtraPunch[]): MergedRow[] {
  const rows: MergedRow[] = [];

  // Timed course-control rows
  for (let i = 0; i < controls.length; i++) {
    if (controls[i].punchTime > 0) rows.push({ kind: "control", ctrl: controls[i], idx: i });
  }
  // Extra punch rows
  for (let i = 0; i < extraPunches.length; i++) {
    rows.push({ kind: "extra", punch: extraPunches[i], extraIdx: i });
  }
  // Sort by punch time
  rows.sort((a, b) => {
    const ta = a.kind === "control" ? a.ctrl.punchTime : a.punch.time;
    const tb = b.kind === "control" ? b.ctrl.punchTime : b.punch.time;
    return ta - tb;
  });
  // Append missing controls (no time) in course order at the end
  for (let i = 0; i < controls.length; i++) {
    if (controls[i].punchTime === 0) rows.push({ kind: "control", ctrl: controls[i], idx: i });
  }
  return rows;
}

export function PunchTable({
  data,
  editable = false,
  compact = false,
  dark = false,
  onAddPunch,
  onRemovePunch,
  onUpdatePunchTime,
  onUpdateStartTime,
  onUpdateFinishTime,
}: PunchTableProps) {
  const { t: tr } = useTranslation("race");
  const t = data.timing;
  const [showAddForm, setShowAddForm] = useState(false);
  const [inlineExtras, setInlineExtras] = useState(false);

  const inlineRows = inlineExtras && data.extraPunches.length > 0
    ? buildInlineRows(data.controls, data.extraPunches)
    : null;

  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {/* Course & Punches table */}
      {data.course && (
        <div className={`${dark ? "bg-slate-800/50 border-slate-700" : "bg-white border-slate-200"} ${compact ? "rounded-lg" : "rounded-xl"} border overflow-hidden`}>
          <div className={`px-4 py-3 border-b ${dark ? "border-slate-700" : "border-slate-200"} flex items-center justify-between gap-3 flex-wrap`}>
            <h3 className={`font-semibold ${dark ? "text-slate-400" : "text-slate-500"} uppercase tracking-wider ${compact ? "text-xs" : "text-sm"}`}>
              {tr("punches")} &mdash; {data.course.name}
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              {/* Adjusted vs raw running time when NoTiming / BadNoTiming
                  legs were deducted. Helps the admin see exactly how much
                  was excluded and on which legs. */}
              {(t.runningTimeAdjustment ?? 0) > 0 && (t.rawRunningTime ?? 0) > 0 && (
                <span className={`text-xs tabular-nums ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {tr("adjustedTime", { time: formatRunningTime(t.runningTime) })}
                  <span className={dark ? "text-slate-500" : "text-slate-400"}>
                    {" \u00b7 "}
                    {tr("rawTime", { time: formatRunningTime(t.rawRunningTime!) })}
                  </span>
                </span>
              )}
              <span className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>
                {/* Numerator: punched required-and-counted positions.
                    Denominator: required positions only (skipped controls
                    were never expected to be punched, so counting them
                    would understate the runner's score). */}
                {
                  data.controls.filter(
                    (c) => c.status === "ok" && (c.positionMode ?? "required") !== "skipped",
                  ).length
                }
                /
                {
                  data.course.requiredControlCount ??
                  data.controls.filter((c) => (c.positionMode ?? "required") !== "skipped").length
                }
                {" "}
                {tr("controlsOk")}
              </span>
            </div>
          </div>

          <table className={`w-full text-sm ${dark ? "text-slate-200" : ""}`}>
            <thead>
              <tr className={`${dark ? "bg-slate-700/50 border-b border-slate-700" : "bg-slate-50 border-b border-slate-200"}`}>
                <th className={`px-4 py-2 text-left font-medium ${dark ? "text-slate-400" : "text-slate-500"} w-12`}>
                  #
                </th>
                <th className={`px-4 py-2 text-left font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {tr("control")}
                </th>
                <th className={`px-4 py-2 text-right font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {tr("time")}
                </th>
                <th className={`px-4 py-2 text-right font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {tr("split")}
                </th>
                <th className={`px-4 py-2 text-right font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {tr("cumulative")}
                </th>
                <th className={`px-4 py-2 text-center font-medium ${dark ? "text-slate-400" : "text-slate-500"} w-16`}>
                  {tr("statusHeader")}
                </th>
                {editable && (
                  <th className={`px-4 py-2 text-center font-medium ${dark ? "text-slate-400" : "text-slate-500"} w-20`}>
                    &nbsp;
                  </th>
                )}
              </tr>
            </thead>
            <tbody className={`divide-y ${dark ? "divide-slate-700" : "divide-slate-100"}`}>
              {/* Start row */}
              <TimingRow
                label="S"
                name={tr("punchStart")}
                time={t.startTime}
                editable={editable}
                canEdit={!!onUpdateStartTime}
                onUpdateTime={onUpdateStartTime}
                dark={dark}
              />

              {inlineRows ? (
                /* Inline view: course controls + extras interleaved by punch time */
                inlineRows.map((row, i) =>
                  row.kind === "control" ? (
                    <ControlRow
                      key={`ctrl-${row.idx}`}
                      ctrl={row.ctrl}
                      idx={row.idx}
                      editable={editable}
                      dark={dark}
                      onRemovePunch={onRemovePunch}
                      onUpdatePunchTime={onUpdatePunchTime}
                    />
                  ) : (
                    <ExtraRow
                      key={`extra-${i}`}
                      punch={row.punch}
                      dark={dark}
                      label={tr("extraPunch")}
                      editable={editable}
                    />
                  )
                )
              ) : (
                /* Normal view: course controls only */
                data.controls.map((ctrl, idx) => (
                  <ControlRow
                    key={idx}
                    ctrl={ctrl}
                    idx={idx}
                    editable={editable}
                    dark={dark}
                    onRemovePunch={onRemovePunch}
                    onUpdatePunchTime={onUpdatePunchTime}
                  />
                ))
              )}

              {/* Finish row */}
              <TimingRow
                label="F"
                name={tr("punchFinish")}
                time={t.finishTime}
                editable={editable}
                canEdit={!!onUpdateFinishTime}
                onUpdateTime={onUpdateFinishTime}
                bold
                dark={dark}
                splitTime={(() => {
                  const lastOk = [...data.controls]
                    .reverse()
                    .find((c) => c.status === "ok");
                  return lastOk && t.finishTime > 0
                    ? t.finishTime - lastOk.punchTime
                    : 0;
                })()}
                cumTime={t.runningTime}
              />
            </tbody>
          </table>
        </div>
      )}

      {/* Extra punches — shown as separate section when not in inline mode */}
      {data.extraPunches.length > 0 && (
        <div className={`${dark ? "bg-amber-900/30 border-amber-700/50" : "bg-amber-50 border-amber-200"} ${compact ? "rounded-lg" : "rounded-xl"} border p-4`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className={`text-sm font-semibold ${dark ? "text-amber-400" : "text-amber-800"}`}>
              {tr("extraPunches")}
            </h3>
            {data.course && (
              <button
                onClick={() => setInlineExtras((v) => !v)}
                className={`text-xs font-medium cursor-pointer ${dark ? "text-amber-300 hover:text-amber-100" : "text-amber-700 hover:text-amber-900"}`}
              >
                {inlineExtras ? tr("hideInline") : tr("showInline")}
              </button>
            )}
          </div>
          {!inlineExtras && (
            <div className="flex flex-wrap gap-2">
              {data.extraPunches.map((p, i) => (
                <span
                  key={i}
                  className={`px-2 py-1 rounded text-xs font-medium tabular-nums ${dark ? "bg-amber-800/50 text-amber-300" : "bg-amber-100 text-amber-800"}`}
                >
                  {p.controlCode} @ {formatMeosTime(p.time)}
                </span>
              ))}
            </div>
          )}
          {inlineExtras && (
            <p className={`text-xs ${dark ? "text-amber-400/70" : "text-amber-700/70"}`}>
              {data.extraPunches.length === 1
                ? "1 extra punch shown inline above"
                : `${data.extraPunches.length} extra punches shown inline above`}
            </p>
          )}
        </div>
      )}

      {/* Missing controls summary */}
      {data.missingControls.length > 0 && (
        <div className={`${dark ? "bg-red-900/30 border-red-700/50" : "bg-red-50 border-red-200"} ${compact ? "rounded-lg" : "rounded-xl"} border p-4`}>
          <h3 className={`text-sm font-semibold ${dark ? "text-red-400" : "text-red-800"} mb-2`}>
            {tr("missingControlsTitle")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {data.missingControls.map((code, i) => (
              <span
                key={i}
                className={`px-3 py-1 rounded-full text-sm font-bold ${dark ? "bg-red-800/50 text-red-300" : "bg-red-100 text-red-800"}`}
              >
                {code}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Add correction: toggle button + form */}
      {editable && onAddPunch && (
        showAddForm ? (
          <AddPunchForm
            onAdd={(code, time) => {
              onAddPunch(code, time);
              setShowAddForm(false);
            }}
            onCancel={() => setShowAddForm(false)}
          />
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 border border-dashed border-blue-300 rounded-lg transition-colors cursor-pointer"
          >
            + {tr("addPunchCorrection")}
          </button>
        )
      )}
    </div>
  );
}

// ─── Control Row with inline time editing ────────────────────

function ControlRow({
  ctrl,
  idx,
  editable,
  dark = false,
  onRemovePunch,
  onUpdatePunchTime,
}: {
  ctrl: ControlMatch;
  idx: number;
  editable: boolean;
  dark?: boolean;
  onRemovePunch?: (punchId: number) => void;
  onUpdatePunchTime?: (punchId: number, newTime: number) => void;
}) {
  const { t: tr } = useTranslation("race");
  const mode = ctrl.positionMode ?? "required";
  const isMissing = ctrl.status === "missing";
  const isSkipped = mode === "skipped";
  const isNoTiming = mode === "noTiming";
  const isFree = ctrl.source === "free";
  const [editingTime, setEditingTime] = useState(false);
  const [timeInput, setTimeInput] = useState("");

  const canEditTime = editable && isFree && ctrl.freePunchId && onUpdatePunchTime;

  const startEdit = () => {
    setTimeInput(ctrl.punchTime > 0 ? formatMeosTime(ctrl.punchTime) : "");
    setEditingTime(true);
  };

  const saveTime = () => {
    if (!ctrl.freePunchId || !onUpdatePunchTime) return;
    const newTime = parseMeosTime(timeInput);
    if (newTime > 0) {
      onUpdatePunchTime(ctrl.freePunchId, newTime);
    }
    setEditingTime(false);
  };

  const cancelEdit = () => {
    setEditingTime(false);
  };

  // Row colour: skipped + missing should look neutral (the runner wasn't
  // required to punch). Skipped + ok is a passive hit (greyed but not
  // failure-coloured). NoTiming uses a faint blue tint to flag "time is
  // not counting here". Required + missing keeps the existing red.
  const rowClass =
    isSkipped
      ? dark
        ? "bg-slate-800/40 hover:bg-slate-700/50"
        : "bg-slate-50 hover:bg-slate-100"
      : isNoTiming
        ? dark
          ? "bg-blue-900/20 hover:bg-blue-900/30"
          : "bg-blue-50 hover:bg-blue-100"
        : isMissing
          ? dark
            ? "bg-red-900/30"
            : "bg-red-50"
          : dark
            ? "hover:bg-slate-700/50"
            : "hover:bg-slate-50";

  return (
    <tr className={rowClass}>
      <td className={`px-4 py-2 tabular-nums ${dark ? "text-slate-500" : "text-slate-400"}`}>
        {idx + 1}
      </td>
      <td className="px-4 py-2 font-medium">
        <span
          className={
            isSkipped
              ? (dark ? "text-slate-400" : "text-slate-500")
              : isMissing
                ? (dark ? "text-red-400" : "text-red-700")
                : isNoTiming
                  ? (dark ? "text-blue-200" : "text-blue-700")
                  : (dark ? "text-slate-100" : "text-slate-900")
          }
        >
          {ctrl.controlCode}
        </span>
        {/* Position-mode badge: tells the admin at a glance why a row
            looks different. Skipped rows render as Bad/Optional in MeOS
            and we treat them identically here; NoTiming gets its own
            label. */}
        {isSkipped && (
          <span
            className={`ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded ${
              dark ? "bg-slate-700/70 text-slate-300" : "bg-slate-200 text-slate-700"
            }`}
            title={tr("statusSkippedHint")}
          >
            {tr("statusSkipped")}
          </span>
        )}
        {isNoTiming && (
          <span
            className={`ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded ${
              dark ? "bg-blue-900/60 text-blue-200" : "bg-blue-100 text-blue-800"
            }`}
            title={tr("statusNoTimingHint")}
          >
            {tr("statusNoTiming")}
          </span>
        )}
        {isFree && (
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-100 text-indigo-700 rounded">
            {tr("manual")}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {editingTime ? (
          <span className="inline-flex items-center gap-1">
            <input
              type="text"
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTime();
                if (e.key === "Escape") cancelEdit();
              }}
              className="w-24 px-1.5 py-0.5 text-sm text-right border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
              autoFocus
            />
            <button
              onClick={saveTime}
              className="text-emerald-600 hover:text-emerald-800 cursor-pointer"
              title="Save"
            >
              &#10003;
            </button>
            <button
              onClick={cancelEdit}
              className="text-slate-400 hover:text-slate-600 cursor-pointer"
              title="Cancel"
            >
              &#10005;
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {ctrl.punchTime > 0 ? formatMeosTime(ctrl.punchTime) : (
              <span className="text-red-500">&mdash;</span>
            )}
            {canEditTime && (
              <button
                onClick={startEdit}
                className="text-slate-300 hover:text-blue-500 cursor-pointer ml-1"
                title="Edit time"
              >
                &#9998;
              </button>
            )}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {ctrl.splitTime > 0 ? (
          // NoTiming legs: display the leg duration but with strikethrough
          // and muted colour so the admin sees "this much time was excluded".
          <span
            className={
              isNoTiming
                ? `line-through ${dark ? "text-slate-500" : "text-slate-400"}`
                : ""
            }
          >
            {formatRunningTime(ctrl.splitTime)}
          </span>
        ) : isSkipped ? (
          <span className={dark ? "text-slate-500" : "text-slate-400"}>&mdash;</span>
        ) : (
          <span className="text-red-500">&mdash;</span>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {ctrl.cumTime > 0 ? formatRunningTime(ctrl.cumTime) : "-"}
      </td>
      <td className="px-4 py-2 text-center">
        {isSkipped ? (
          // Bad / Optional / BadNoTiming: not a failure when missing; show
          // a neutral marker. When the runner did punch the skipped
          // control, show a muted check (counted for splits, not for MP).
          ctrl.status === "ok" ? (
            <span className={dark ? "text-slate-400" : "text-slate-500"}>&#10003;</span>
          ) : (
            <span className={dark ? "text-slate-500" : "text-slate-400"}>&#8226;</span>
          )
        ) : isMissing ? (
          <span className={`${dark ? "text-red-400" : "text-red-600"} font-bold`}>&#10007;</span>
        ) : (
          <span className={dark ? "text-emerald-400" : "text-emerald-600"}>&#10003;</span>
        )}
      </td>
      {editable && (
        <td className="px-4 py-2 text-center">
          {isFree && onRemovePunch && ctrl.freePunchId && (
            <button
              onClick={() => onRemovePunch(ctrl.freePunchId!)}
              className="text-xs text-red-500 hover:text-red-700 cursor-pointer"
              title="Remove this manual punch"
            >
              &#10005;
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

// ─── Extra punch row (shown when inline-extras toggle is on) ─

function ExtraRow({
  punch,
  dark = false,
  label,
  editable,
}: {
  punch: ExtraPunch;
  dark?: boolean;
  label: string;
  editable: boolean;
}) {
  return (
    <tr className={dark ? "bg-amber-900/20" : "bg-amber-50"}>
      <td className={`px-4 py-2 tabular-nums ${dark ? "text-slate-500" : "text-slate-400"}`}>
        &mdash;
      </td>
      <td className="px-4 py-2 font-medium">
        <span className={dark ? "text-amber-300" : "text-amber-700"}>
          {punch.controlCode}
        </span>
      </td>
      <td className={`px-4 py-2 text-right tabular-nums ${dark ? "text-amber-300" : "text-amber-700"}`}>
        {punch.time > 0 ? formatMeosTime(punch.time) : <span className="text-slate-400">&mdash;</span>}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        <span className={dark ? "text-slate-500" : "text-slate-400"}>&mdash;</span>
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        <span className={dark ? "text-slate-500" : "text-slate-400"}>&mdash;</span>
      </td>
      <td className="px-4 py-2 text-center">
        <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${dark ? "bg-amber-800/60 text-amber-300" : "bg-amber-100 text-amber-700"}`}>
          {label}
        </span>
      </td>
      {editable && <td />}
    </tr>
  );
}

// ─── Start / Finish row with optional inline editing ─────────

function TimingRow({
  label,
  name,
  time,
  editable,
  canEdit,
  onUpdateTime,
  bold,
  dark = false,
  splitTime,
  cumTime,
}: {
  label: string;
  name: string;
  time: number;
  editable: boolean;
  canEdit: boolean;
  onUpdateTime?: (time: number) => void;
  bold?: boolean;
  dark?: boolean;
  splitTime?: number;
  cumTime?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [timeInput, setTimeInput] = useState("");

  const startEdit = () => {
    setTimeInput(time > 0 ? formatMeosTime(time) : "");
    setEditing(true);
  };

  const saveTime = () => {
    if (!onUpdateTime) return;
    const newTime = parseMeosTime(timeInput);
    onUpdateTime(newTime);
    setEditing(false);
  };

  const clearTime = () => {
    if (!onUpdateTime) return;
    onUpdateTime(0);
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  const isFinish = label === "F";
  const rowClass = bold
    ? `font-medium border-t-2 ${dark ? "border-slate-600" : "border-slate-200"}`
    : (dark ? "text-slate-400" : "text-slate-500");

  return (
    <tr className={rowClass}>
      <td className="px-4 py-2">{label}</td>
      <td className="px-4 py-2">{name}</td>
      <td className="px-4 py-2 text-right tabular-nums">
        {editing ? (
          <span className="inline-flex items-center gap-1">
            <input
              type="text"
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTime();
                if (e.key === "Escape") cancelEdit();
              }}
              placeholder="HH:MM:SS"
              className="w-24 px-1.5 py-0.5 text-sm text-right border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
              autoFocus
            />
            <button
              onClick={saveTime}
              className="text-emerald-600 hover:text-emerald-800 cursor-pointer"
              title="Save"
            >
              &#10003;
            </button>
            {time > 0 && (
              <button
                onClick={clearTime}
                className="text-red-400 hover:text-red-600 cursor-pointer"
                title="Clear time"
              >
                &#10007;
              </button>
            )}
            <button
              onClick={cancelEdit}
              className="text-slate-400 hover:text-slate-600 cursor-pointer"
              title="Cancel"
            >
              &#9747;
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {time > 0 ? (
              formatMeosTime(time)
            ) : (
              <span className="text-red-500">&mdash;</span>
            )}
            {editable && canEdit && (
              <button
                onClick={startEdit}
                className="text-slate-300 hover:text-blue-500 cursor-pointer ml-1"
                title={`Edit ${name.toLowerCase()} time`}
              >
                &#9998;
              </button>
            )}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {splitTime && splitTime > 0 ? formatRunningTime(splitTime) : "-"}
      </td>
      <td className={`px-4 py-2 text-right tabular-nums ${isFinish && cumTime && cumTime > 0 ? "font-bold" : ""}`}>
        {cumTime && cumTime > 0 ? formatRunningTime(cumTime) : "-"}
      </td>
      <td className="px-4 py-2 text-center">
        {time > 0 ? (
          <span className={dark ? "text-emerald-400" : "text-emerald-600"}>&#10003;</span>
        ) : (
          <span className={`${dark ? "text-red-400" : "text-red-600"} font-bold`}>&#10007;</span>
        )}
      </td>
      {editable && <td />}
    </tr>
  );
}

// ─── Add Punch Form ──────────────────────────────────────────

function AddPunchForm({
  onAdd,
  onCancel,
}: {
  onAdd: (controlCode: number, time: number) => void;
  onCancel: () => void;
}) {
  const { t: tr } = useTranslation("race");
  const [controlCode, setControlCode] = useState("");
  const [timeStr, setTimeStr] = useState("");
  const [adding, setAdding] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = parseInt(controlCode, 10);
    const time = parseMeosTime(timeStr);
    if (isNaN(code) || code <= 0 || time <= 0) return;
    setAdding(true);
    onAdd(code, time);
    setControlCode("");
    setTimeStr("");
    setTimeout(() => setAdding(false), 500);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-xl border border-slate-200 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
          {tr("addPunchCorrection")}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          {tr("cancelLabel")}
        </button>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">{tr("controlCode")}</label>
          <input
            type="number"
            value={controlCode}
            onChange={(e) => setControlCode(e.target.value)}
            placeholder="e.g. 67"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            autoFocus
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">{tr("timeHHMMSS")}</label>
          <input
            type="text"
            value={timeStr}
            onChange={(e) => setTimeStr(e.target.value)}
            placeholder="12:45:30"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
        >
          {adding ? tr("adding") : tr("addPunch")}
        </button>
      </div>
    </form>
  );
}

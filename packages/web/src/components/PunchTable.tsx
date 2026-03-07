import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMeosTime, formatRunningTime, parseMeosTime } from "@oxygen/shared";

interface ControlMatch {
  controlIndex: number;
  controlCode: number;
  punchTime: number;
  splitTime: number;
  cumTime: number;
  status: "ok" | "missing" | "extra";
  source: "card" | "free" | "";
  freePunchId?: number;
}

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
  };
  course: {
    name: string;
    length: number;
    controlCount: number;
  } | null;
  extraPunches: ExtraPunch[];
  missingControls: number[];
}

interface PunchTableProps {
  data: PunchTableData;
  editable?: boolean;
  compact?: boolean;
  onAddPunch?: (controlCode: number, time: number) => void;
  onRemovePunch?: (punchId: number) => void;
  onUpdatePunchTime?: (punchId: number, newTime: number) => void;
  onUpdateStartTime?: (time: number) => void;
  onUpdateFinishTime?: (time: number) => void;
}

export function PunchTable({
  data,
  editable = false,
  compact = false,
  onAddPunch,
  onRemovePunch,
  onUpdatePunchTime,
  onUpdateStartTime,
  onUpdateFinishTime,
}: PunchTableProps) {
  const { t: tr } = useTranslation("race");
  const t = data.timing;
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {/* Course & Punches table */}
      {data.course && (
        <div className={`bg-white ${compact ? "rounded-lg border border-slate-200" : "rounded-xl border border-slate-200"} overflow-hidden`}>
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className={`font-semibold text-slate-500 uppercase tracking-wider ${compact ? "text-xs" : "text-sm"}`}>
              {tr("punches")} &mdash; {data.course.name}
            </h3>
            <span className="text-xs text-slate-400">
              {data.controls.filter((c) => c.status === "ok").length}/
              {data.controls.length} {tr("controlsOk")}
            </span>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-2 text-left font-medium text-slate-500 w-12">
                  #
                </th>
                <th className="px-4 py-2 text-left font-medium text-slate-500">
                  {tr("control")}
                </th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">
                  {tr("time")}
                </th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">
                  {tr("split")}
                </th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">
                  {tr("cumulative")}
                </th>
                <th className="px-4 py-2 text-center font-medium text-slate-500 w-16">
                  {tr("statusHeader")}
                </th>
                {editable && (
                  <th className="px-4 py-2 text-center font-medium text-slate-500 w-20">
                    &nbsp;
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {/* Start row */}
              <TimingRow
                label="S"
                name={tr("punchStart")}
                time={t.startTime}
                editable={editable}
                canEdit={!!onUpdateStartTime}
                onUpdateTime={onUpdateStartTime}
              />

              {/* Control rows */}
              {data.controls.map((ctrl, idx) => (
                <ControlRow
                  key={idx}
                  ctrl={ctrl}
                  idx={idx}
                  editable={editable}
                  onRemovePunch={onRemovePunch}
                  onUpdatePunchTime={onUpdatePunchTime}
                />
              ))}

              {/* Finish row */}
              <TimingRow
                label="F"
                name={tr("punchFinish")}
                time={t.finishTime}
                editable={editable}
                canEdit={!!onUpdateFinishTime}
                onUpdateTime={onUpdateFinishTime}
                bold
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

      {/* Extra punches */}
      {data.extraPunches.length > 0 && (
        <div className={`bg-amber-50 ${compact ? "rounded-lg" : "rounded-xl"} border border-amber-200 p-4`}>
          <h3 className="text-sm font-semibold text-amber-800 mb-2">
            {tr("extraPunches")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {data.extraPunches.map((p, i) => (
              <span
                key={i}
                className="px-2 py-1 bg-amber-100 rounded text-xs font-medium text-amber-800 tabular-nums"
              >
                {p.controlCode} @ {formatMeosTime(p.time)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Missing controls summary */}
      {data.missingControls.length > 0 && (
        <div className={`bg-red-50 ${compact ? "rounded-lg" : "rounded-xl"} border border-red-200 p-4`}>
          <h3 className="text-sm font-semibold text-red-800 mb-2">
            {tr("missingControlsTitle")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {data.missingControls.map((code, i) => (
              <span
                key={i}
                className="px-3 py-1 bg-red-100 rounded-full text-sm font-bold text-red-800"
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
  onRemovePunch,
  onUpdatePunchTime,
}: {
  ctrl: ControlMatch;
  idx: number;
  editable: boolean;
  onRemovePunch?: (punchId: number) => void;
  onUpdatePunchTime?: (punchId: number, newTime: number) => void;
}) {
  const { t: tr } = useTranslation("race");
  const isMissing = ctrl.status === "missing";
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

  return (
    <tr className={isMissing ? "bg-red-50" : "hover:bg-slate-50"}>
      <td className="px-4 py-2 text-slate-400 tabular-nums">
        {idx + 1}
      </td>
      <td className="px-4 py-2 font-medium">
        <span className={isMissing ? "text-red-700" : "text-slate-900"}>
          {ctrl.controlCode}
        </span>
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
        {ctrl.splitTime > 0 ? formatRunningTime(ctrl.splitTime) : (
          <span className="text-red-500">&mdash;</span>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {ctrl.cumTime > 0 ? formatRunningTime(ctrl.cumTime) : "-"}
      </td>
      <td className="px-4 py-2 text-center">
        {isMissing ? (
          <span className="text-red-600 font-bold">&#10007;</span>
        ) : (
          <span className="text-emerald-600">&#10003;</span>
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

// ─── Start / Finish row with optional inline editing ─────────

function TimingRow({
  label,
  name,
  time,
  editable,
  canEdit,
  onUpdateTime,
  bold,
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
    ? "font-medium border-t-2 border-slate-200"
    : "text-slate-500";

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
          <span className="text-emerald-600">&#10003;</span>
        ) : (
          <span className="text-red-600 font-bold">&#10007;</span>
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

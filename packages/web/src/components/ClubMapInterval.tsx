/**
 * The contour interval of a club map (docs/course-elevation.md §0.43): the
 * number a person confirms once, which every event using the map follows.
 * Setting it clears and computes again the computed climbs of those events.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { INTERVAL_SUGGESTIONS, parseInterval } from "../pages/editor/contourIntervalState";

export function ClubMapInterval({ id, confirmedM, assumedM }: { id: string; confirmedM: number | null; assumedM: number | null }) {
  const { t } = useTranslation("library");
  const utils = trpc.useUtils();
  const set = trpc.clubMap.setContourInterval.useMutation({ onSuccess: () => void utils.clubMap.list.invalidate() });
  const shown = String(confirmedM ?? assumedM ?? "");
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (assumedM === null) return null;
  const parsed = parseInterval(text);
  const confirmed = confirmedM !== null;
  return (
    <div data-testid="club-map-interval" data-confirmed={confirmed ? String(confirmedM) : ""} className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <label className="flex items-center gap-1.5">
        {t("contourInterval")}
        <input data-testid="club-map-interval-input" list={`club-map-interval-list-${id}`} inputMode="decimal" value={text} disabled={set.isPending}
          onChange={(e) => setText(e.target.value)}
          className="w-14 px-1 py-0.5 rounded border border-slate-200 bg-white text-xs font-mono" />
        <datalist id={`club-map-interval-list-${id}`}>{INTERVAL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
        m
      </label>
      <span data-testid="club-map-interval-state" data-state={confirmed ? "confirmed" : "unconfirmed"}
        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${confirmed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
        {t(confirmed ? "intervalConfirmed" : "intervalNotConfirmed")}
      </span>
      <button type="button" data-testid="club-map-interval-save" disabled={set.isPending || parsed === null || parsed === confirmedM}
        onClick={() => { if (parsed !== null) set.mutate({ id, intervalM: parsed }); }}
        className="px-2 py-0.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer">
        {t(confirmed ? "intervalChange" : "intervalConfirm")}
      </button>
      {confirmed && (
        <button type="button" data-testid="club-map-interval-clear" disabled={set.isPending} onClick={() => set.mutate({ id, intervalM: null })}
          className="px-2 py-0.5 border border-slate-200 rounded-lg text-slate-500 hover:bg-slate-50 disabled:opacity-50 cursor-pointer">
          {t("intervalClear")}
        </button>
      )}
      <span className="text-[11px] text-slate-400">{t("intervalFollows")}</span>
      {set.error && <span className="text-[11px] text-red-600">{set.error.message}</span>}
    </div>
  );
}

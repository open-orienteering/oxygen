/**
 * The convert panel under the *GPS tracks* list (docs/course-editor.md §13 "GPS tracks: convert"; docs/map-gps-tracks.md
 * §6; row G26): the line-symbol picker (ski-O track group first), smoothing and simplification, the live node count
 * with the 2000-node warning, and *Convert* / *Cancel*. The preview is drawn on the map by Map mode (the viewer's draft).
 */

import { useTranslation } from "react-i18next";
import { SymbolPicker } from "../SymbolPicker";
import { MAP_NODES_MAX } from "../nodes";
import { SMOOTH_MAX_M, SMOOTH_MIN_M, TOL_MAX_MM, TOL_MIN_MM } from "./convert";
import type { TrackConvert } from "./useTrackConvert";

export function ConvertPanel({ convert, tracks, documentHash, nameId, busy, onApply, onCancel }: {
  convert: TrackConvert;
  /** Tracks selected. */
  tracks: number;
  documentHash: string;
  nameId: string;
  /** A write is in flight. */
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation("editor");
  const fmt = (v: number, digits: number) => new Intl.NumberFormat(i18n.language, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  const { settings, palette } = convert;
  const canApply = !!convert.result && !busy;
  return (
    <div data-testid="editor-tracks-convert-panel" data-tracks={tracks} className="flex flex-col gap-1.5 mt-1 pt-1.5 border-t border-slate-200">
      <p className="text-[11px] font-medium text-slate-700">{t("trackConvertTitle", { count: tracks })}</p>
      {palette && (
        <SymbolPicker groups={palette} kind="line" query={convert.query} onQuery={convert.onQuery} pressed={convert.chosenKey} onPick={convert.onPick}
          documentHash={documentHash} nameId={nameId} onEscape={onCancel}
          hint={convert.chosenKey ? null : { testId: "editor-map-palette-pick", text: t("trackConvertPick") }} />
      )}
      <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <span className="w-24 shrink-0">{t("trackConvertSmoothing")}</span>
        <input data-testid="editor-tracks-convert-smoothing" type="range" min={SMOOTH_MIN_M} max={SMOOTH_MAX_M} step={1} value={settings.windowM}
          onChange={(e) => convert.onSettings({ windowM: Number(e.currentTarget.value) })} className="flex-1 min-w-0" />
        <span data-testid="editor-tracks-convert-smoothing-value" className="w-12 text-right tabular-nums">
          {settings.windowM === 0 ? t("trackConvertOff") : `${settings.windowM} m`}
        </span>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <span className="w-24 shrink-0">{t("trackConvertTolerance")}</span>
        <input data-testid="editor-tracks-convert-tolerance" type="range" min={TOL_MIN_MM} max={TOL_MAX_MM} step={0.01} value={settings.toleranceMm}
          onChange={(e) => convert.onSettings({ toleranceMm: Number(e.currentTarget.value) })} className="flex-1 min-w-0" />
        <span data-testid="editor-tracks-convert-tolerance-value" className="w-12 text-right tabular-nums">{fmt(settings.toleranceMm, 2)} mm</span>
      </label>
      <p data-testid="editor-tracks-convert-nodes" data-nodes={convert.totalNodes} data-max={convert.maxNodes} className="text-[11px] text-slate-600">
        {t("trackConvertNodes", { count: convert.totalNodes })}
      </p>
      {convert.over && (
        <p data-testid="editor-tracks-convert-warning" className="text-[11px] text-amber-700">{t("trackConvertOver", { max: MAP_NODES_MAX })}</p>
      )}
      {convert.skipped.length > 0 && (
        <p data-testid="editor-tracks-convert-skipped" data-count={convert.skipped.length} className="text-[11px] text-amber-700">
          {t("trackConvertSkipped", { count: convert.skipped.length })}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <button type="button" data-testid="editor-tracks-convert-apply" disabled={!canApply} onClick={onApply}
          title={convert.chosenKey ? undefined : t("trackConvertPick")}
          className="px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed">
          {t("trackConvertApply")}
        </button>
        <button type="button" data-testid="editor-tracks-convert-cancel" onClick={onCancel}
          className="px-2 py-0.5 rounded border border-slate-200 text-slate-700 hover:bg-white cursor-pointer">
          {t("trackConvertCancel")}
        </button>
      </div>
    </div>
  );
}

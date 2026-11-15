/**
 * The inspector's *GPS tracks* section (docs/course-editor.md §13 "GPS tracks"; docs/map-gps-tracks.md §5.1): import
 * by the file picker or a drop, the list with show / hide, rename, delete and locate, or the reason it is off.
 */

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconEye, IconEyeOff } from "../../../../../components/map-icons";
import type { MapTracks } from "./useMapTracks";
import type { TrackRow } from "./model";

type Panel = NonNullable<MapTracks["panel"]>;

function TrackRowItem({ row, onVisible, onRename, onDelete, onLocate }: {
  row: TrackRow;
  onVisible: Panel["onVisible"];
  onRename: Panel["onRename"];
  onDelete: Panel["onDelete"];
  onLocate: Panel["onLocate"];
}) {
  const { t, i18n } = useTranslation("editor");
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const { meta, geometry } = row;
  const lengthM = geometry ? Math.round(geometry.lengthM * 10) / 10 : null;
  const fmt = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const length = lengthM === null ? "…" : lengthM < 1000 ? `${fmt.format(Math.round(lengthM))} m` : `${fmt.format(Math.round(lengthM / 100) / 10)} km`;
  const date = meta.recordedAt === null ? "—" : new Date(meta.recordedAt).toLocaleDateString(i18n.language);
  const commit = (value: string) => {
    setEditing(false);
    if (!cancelled.current) onRename(meta.id, value);
    cancelled.current = false;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") {
      cancelled.current = true;
      e.currentTarget.blur();
    }
    e.stopPropagation();
  };
  const outside = geometry?.outside ?? 0;
  return (
    <li data-testid="editor-track-row" data-track-id={meta.id} data-state={row.state} data-visible={row.visible ? "true" : "false"}
      data-points={row.points} data-length-m={lengthM ?? undefined} data-outside={geometry ? outside : undefined}
      data-converted={meta.convertedOp ? "true" : "false"} className="flex flex-col gap-0.5 rounded px-1 py-1 hover:bg-slate-50">
      <div className="flex items-center gap-1.5">
        <span data-testid="editor-track-swatch" data-colour={row.colour} className="shrink-0 w-3 h-1.5 rounded-sm" style={{ backgroundColor: row.colour }} />
        {editing ? (
          <input data-testid="editor-track-name-input" autoFocus defaultValue={meta.name ?? ""} placeholder={meta.sourceName} maxLength={200}
            onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={onKey} aria-label={t("trackRename")}
            className="flex-1 min-w-0 px-1 py-0 border border-slate-300 rounded text-xs" />
        ) : (
          <button type="button" data-testid="editor-track-name" onClick={() => onLocate(meta.id)} disabled={!geometry}
            title={row.error ? t(`trackRowError_${row.error}`, { defaultValue: row.error }) : t("trackLocate")}
            className="flex-1 min-w-0 text-left truncate cursor-pointer disabled:cursor-default">
            {row.label}
          </button>
        )}
        <button type="button" data-testid="editor-track-visible" aria-pressed={row.visible} onClick={() => onVisible(meta.id, !row.visible)}
          title={row.visible ? t("trackHide") : t("trackShow")} aria-label={row.visible ? t("trackHide") : t("trackShow")}
          className={`shrink-0 p-0.5 rounded cursor-pointer hover:bg-white ${row.visible ? "text-slate-600" : "text-slate-300"}`}>
          {row.visible ? <IconEye className="w-3.5 h-3.5" /> : <IconEyeOff className="w-3.5 h-3.5" />}
        </button>
        <button type="button" data-testid="editor-track-rename" onClick={() => setEditing(true)} title={t("trackRename")} aria-label={t("trackRename")}
          className="shrink-0 px-1 rounded text-slate-500 hover:bg-white cursor-pointer">✎</button>
        <button type="button" data-testid="editor-track-delete" onClick={() => onDelete(meta.id)} title={t("trackDelete")} aria-label={t("trackDelete")}
          className="shrink-0 px-1 rounded text-slate-500 hover:bg-white hover:text-red-600 cursor-pointer">×</button>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 pl-4.5 text-[11px] text-slate-500">
        <span data-testid="editor-track-date" className="whitespace-nowrap">{date}</span>
        <span data-testid="editor-track-stats" className="whitespace-nowrap">{t("trackStats", { length, count: row.points })}</span>
        {outside > 0 && (
          <span data-testid="editor-track-outside" className="whitespace-nowrap text-amber-700" title={t("trackOutsideHint")}>{t("trackOutside", { count: outside })}</span>
        )}
        {meta.convertedOp && <span data-testid="editor-track-converted" className="whitespace-nowrap text-emerald-700">{t("trackConverted")}</span>}
        {row.error && <span className="whitespace-nowrap text-red-600">{t(`trackRowError_${row.error}`, { defaultValue: row.error })}</span>}
      </div>
    </li>
  );
}

export function TracksPanel({ panel }: { panel: Panel }) {
  const { t } = useTranslation("editor");
  const input = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  if (panel.disabled) {
    return (
      <p data-testid="editor-tracks-disabled" data-reason={panel.disabled} className="px-2.5 py-2 text-[11px] text-slate-500">
        {t(`tracksDisabled_${panel.disabled}`)}
      </p>
    );
  }
  const files = (list: FileList | null) => (list ? Array.from(list) : []);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!panel.importing) panel.onImport(files(e.dataTransfer.files));
  };
  const r = panel.result;
  const skipped = r ? r.skipped.points + r.skipped.segments + r.skipped.waypoints : 0;
  return (
    <div data-testid="editor-tracks-drop" data-drag-over={dragOver ? "true" : undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)} onDrop={onDrop}
      className={`px-2.5 py-2 flex flex-col gap-1.5 text-xs ${dragOver ? "bg-purple-50 outline-2 outline-dashed outline-purple-300 -outline-offset-2" : ""}`}>
      <div className="flex items-center gap-1.5">
        <button type="button" data-testid="editor-tracks-import" data-busy={panel.importing ? "true" : undefined} disabled={panel.importing}
          onClick={() => input.current?.click()}
          className="px-2 py-0.5 rounded border border-slate-200 text-slate-700 hover:bg-white disabled:opacity-50 cursor-pointer disabled:cursor-wait">
          {panel.importing ? t("tracksImporting") : t("tracksImport")}
        </button>
        <span className="text-[11px] text-slate-400">{t("tracksDropHint")}</span>
        <input ref={input} type="file" multiple accept=".gpx,application/gpx+xml" data-testid="editor-tracks-file" className="hidden"
          onChange={(e) => {
            const picked = files(e.currentTarget.files);
            e.currentTarget.value = "";
            panel.onImport(picked);
          }} />
      </div>
      {r && (
        <div className="flex flex-col gap-0.5 text-[11px]">
          <p data-testid="editor-tracks-import-result" data-imported={r.imported} className="text-slate-600">
            {t("tracksImported", { count: r.imported })}
            {skipped > 0 && ` ${t("tracksSkipped", { points: r.skipped.points, segments: r.skipped.segments, waypoints: r.skipped.waypoints })}`}
          </p>
          {r.issues.map((i, k) => (
            <p key={k} data-testid="editor-tracks-import-error" data-file={i.file} data-code={i.code} className="text-red-600">
              {i.file}{i.track ? ` — ${i.track}` : ""}: {t(`tracksImportError_${i.code}`, { defaultValue: t("tracksImportError_failed") })}
            </p>
          ))}
        </div>
      )}
      {panel.loading ? (
        <p className="text-[11px] text-slate-400">…</p>
      ) : panel.rows.length === 0 ? (
        <p data-testid="editor-tracks-none" className="text-[11px] text-slate-500">{t("tracksNone")}</p>
      ) : (
        <ul className="flex flex-col">
          {panel.rows.map((row) => (
            <TrackRowItem key={row.meta.id} row={row} onVisible={panel.onVisible} onRename={panel.onRename} onDelete={panel.onDelete} onLocate={panel.onLocate} />
          ))}
        </ul>
      )}
    </div>
  );
}

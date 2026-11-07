/**
 * The editor's map info (docs/course-editor.md §2, P6): a map icon in the top
 * bar (`editor-map-info`, after Export ▾) opens a modal
 * (`editor-map-info-dialog`) with what the editor knows about the event's map
 * — its name, scale, north lines, file and document — and the map's actions:
 * *Review symbols* (map-symbols.md §8.7), *Replace map* and *From club
 * library* (`useMapReplace`, shared with `MapPanel`'s drop zone). It took the
 * place of `MapPanel`'s map-info footer. The dialog is portalled to the
 * fullscreen element when there is one (MapPanel's root: the editor stays in
 * it), else to the body. Escape closes
 * only the dialog (the editor's Escape cascade, §3, is not stepped) and the
 * editor's single-key shortcuts are inert while it is open. Desktop only: the
 * phone's top bar is `FieldTopBar`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { IconMap } from "../../components/map-icons";
import { NorthLinesBadge } from "../../components/NorthLinesBadge";
import { ClubMapPicker } from "../../components/ClubMapPicker";
import { useMapReplace } from "../../components/useMapReplace";
import { mapInfoRows, type MapInfoInput, type MapInfoRow } from "../../lib/editor/map-info";

const LABEL = "w-24 shrink-0 text-slate-500";

const dataAttrs =(data: Record<string, string>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The top bar's map icon and its dialog. The upload state lives here, so an upload started in the dialog survives closing it. */
export function MapInfoButton({ map }: { map: MapInfoInput }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const replace = useMapReplace();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Focus is not handed back to the icon: the editor's Enter (§6.1, it puts an armed tool away) would press it.
  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.blur();
  }, []);
  const label = t("mapInfo");
  return (
    <>
      <button ref={buttonRef} type="button" data-testid="editor-map-info" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen((v) => !v)}
        className={`relative flex items-center rounded-md p-1 cursor-pointer shrink-0 ${open ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}>
        <IconMap className="w-4 h-4" />
      </button>
      {open && <MapInfoDialog map={map} replace={replace} onClose={close} />}
      {/* Outside the dialog: the file chooser's change still lands when the dialog was closed meanwhile. */}
      <input {...replace.fileInput} data-testid="editor-map-info-file-input" />
    </>
  );
}

function MapInfoDialog({ map, replace, onClose }: { map: MapInfoInput; replace: ReturnType<typeof useMapReplace>; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const { t: td } = useTranslation("dashboard");
  const { t: tl } = useTranslation("library");
  const { t: tr } = useTranslation("mapReview");
  const { t: tc } = useTranslation("common");
  const { nameId } = useParams<{ nameId: string }>();
  const titleId = "editor-map-info-title";
  const closeRef = useRef<HTMLButtonElement>(null);

  // A modal: while it is open no keydown reaches the editor's handlers (window, capture phase: first of all
  // listeners), so the tools' letters do nothing and Escape closes the club picker, then the dialog — never a tool,
  // the selection or the course (§3). Tab, Enter and Space keep their default actions on the dialog's buttons.
  const { open: pickerOpen, setOpen: setPickerOpen } = replace.library;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (pickerOpen) setPickerOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pickerOpen, setPickerOpen]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  const info = mapInfoRows(map, t, formatDate);
  const hasMap = map.fileName !== null;
  const row = (r: MapInfoRow) => (
    <div key={r.id} data-testid={`editor-map-info-${r.id}`} {...dataAttrs(r.data)} className="flex gap-3">
      <dt className={LABEL}>{t(r.label)}</dt>
      <dd className="text-slate-800 min-w-0 break-words">{r.text}</dd>
    </div>
  );
  const [nameRow, ...restRows] = info.map;
  const scaleRow = restRows.find((r) => r.id === "scale");
  const fileRow = restRows.find((r) => r.id === "file");
  const action = "px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer";

  // Portalled: the top bar's row is a stacking context (MapPanel's toolbar, `relative z-10`) under the shell's
  // header, so a fixed layer inside it could not dim the header. In fullscreen only the fullscreen element's
  // subtree is drawn, so the portal goes there (MapPanel's root, §2).
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" aria-label={tc("close")} tabIndex={-1} onClick={onClose}
        data-testid="editor-map-info-backdrop" className="absolute inset-0 bg-black/40 cursor-default" />
      <div data-testid="editor-map-info-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-white rounded-xl shadow-lg w-full max-w-md max-h-[calc(100%-2rem)] overflow-auto">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
          <span className="mt-0.5 flex items-center justify-center w-8 h-8 rounded-lg bg-purple-50 text-purple-700 shrink-0">
            <IconMap className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-semibold text-slate-900">{t("mapInfo")}</h2>
            {nameRow ? (
              <p data-testid="editor-map-info-name" {...dataAttrs(nameRow.data)} className="text-sm text-slate-600 truncate" title={nameRow.text}>{nameRow.text}</p>
            ) : (
              <p data-testid="editor-map-info-none" className="text-sm text-slate-500">{t("mapInfoNone")}</p>
            )}
          </div>
          <button ref={closeRef} type="button" data-testid="editor-map-info-close" onClick={onClose} aria-label={tc("close")}
            className="text-slate-400 hover:text-slate-600 cursor-pointer p-1 -mr-1 rounded-md hover:bg-slate-100">
            <svg aria-hidden width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"><path d="M5 5l10 10M15 5 5 15" /></svg>
          </button>
        </div>

        {hasMap && (
          <div className="px-5 py-3 space-y-3 text-xs">
            <dl className="space-y-1.5">
              {scaleRow && row(scaleRow)}
              <div data-testid="editor-map-info-north" className="flex items-center gap-3">
                <dt className={LABEL}>{t("mapInfoNorth")}</dt>
                <dd className="min-w-0">
                  {map.meridianStalenessDeg === null
                    ? <span className="text-slate-500">{tl("northLinesNone")}</span>
                    : <NorthLinesBadge stalenessDeg={map.meridianStalenessDeg} className="rounded-lg! py-1" />}
                </dd>
              </div>
              {fileRow && row(fileRow)}
            </dl>
            {info.document.length > 0 && info.documentData && (
              <section data-testid="editor-map-info-document" {...dataAttrs(info.documentData)} className="pt-3 border-t border-slate-100">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{t("mapInfoDocument")}</h3>
                <dl className="space-y-1.5">{info.document.map(row)}</dl>
              </section>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-xl space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {hasMap && nameId && map.documentHash && (
              // Optional for event maps (06 §5.1, map-symbols.md §8.7).
              <Link to={`/${nameId}/map-review/${map.documentHash}`} data-testid="editor-map-info-review"
                className={`${action} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>
                {tr("openReview")}
              </Link>
            )}
            <button type="button" data-testid="editor-map-info-replace" onClick={replace.openFilePicker}
              className={`${action} bg-blue-600 text-white hover:bg-blue-700`}>
              {hasMap ? td("replaceMap") : td("uploadMap")}
            </button>
            {replace.library.available && (
              <button type="button" data-testid="editor-map-info-library" onClick={() => setPickerOpen(true)}
                className={`${action} border border-blue-200 bg-white text-blue-700 hover:bg-blue-50`}>
                {tl("fromClubLibrary")}
              </button>
            )}
          </div>
          {replace.uploading && <p className="text-xs text-blue-600">{td(hasMap ? "uploadingNewMap" : "uploading")}</p>}
          {replace.error && <p className="text-xs text-red-600">{replace.error}</p>}
          {replace.notice && (
            <div data-testid="map-upload-notice" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
              <span className="flex-1">{replace.notice}</span>
              <button type="button" className="cursor-pointer text-amber-700 hover:text-amber-900" aria-label={tl("cancel")} onClick={replace.dismissNotice}>×</button>
            </div>
          )}
        </div>
      </div>
      <ClubMapPicker library={replace.library} />
    </div>,
    document.fullscreenElement ?? document.body,
  );
}

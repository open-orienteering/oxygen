/**
 * The inspector's *Map object* section (docs/course-editor.md §13 "Inspector"): the selected document object's
 * symbol (number, name, swatch) and *Hide* / *Restore*.
 */

import { useTranslation } from "react-i18next";
import { swatchUrl } from "../../../../lib/editor/symbol-groups";
import { refKey, type MapObjectInfo } from "./model";

export function MapObjectSection({ info, hidden, documentHash, nameId, canWrite, onHide, onRestore }: {
  info: MapObjectInfo | null;
  hidden: boolean;
  documentHash: string;
  nameId: string;
  /** Hide / Restore are writable now (corrections on, `courses.edit`). */
  canWrite: boolean;
  onHide: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("editor");
  if (!info) return <p data-testid="editor-map-object-none" className="px-2.5 py-2 text-[11px] text-slate-500">{t("mapObjectNone")}</p>;
  const src = swatchUrl(info.swatch, documentHash, nameId);
  return (
    <div data-testid="editor-map-object" data-ref={refKey(info.ref)} data-hidden={hidden ? "true" : "false"} data-symbol={info.symbolIdx}
      className="px-2.5 py-2 flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        {src
          ? <img data-testid="editor-map-object-swatch" src={src} alt="" className="w-6 h-6 shrink-0 rounded border border-slate-200 bg-white object-contain" />
          : <span data-testid="editor-map-object-swatch" className="w-6 h-6 shrink-0 rounded border border-dashed border-slate-300" />}
        <span data-testid="editor-map-object-symbol" className="truncate" title={`${info.code} ${info.name}`}>
          <span className="font-mono text-slate-500">{info.code}</span> {info.name}
        </span>
        {hidden && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-amber-700">{t("mapObjectHidden")}</span>}
      </div>
      {hidden ? (
        <button type="button" data-testid="editor-map-object-restore" disabled={!canWrite} onClick={onRestore}
          className="w-fit px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
          {t("mapRestore")}
        </button>
      ) : (
        <>
          <button type="button" data-testid="editor-map-object-hide" disabled={!canWrite} onClick={onHide}
            className="w-fit px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
            {t("mapHide")}
          </button>
          {canWrite && <p className="text-[11px] text-slate-500">{t("mapObjectHint")}</p>}
        </>
      )}
    </div>
  );
}

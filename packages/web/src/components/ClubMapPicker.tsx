/**
 * The club library's map picker (docs/club-library.md "Copy-on-use"): a modal
 * list of the club's maps; a pick copies that map's current version into the
 * event. Opened from `MapPanel`'s drop zone and the course editor's map-info
 * dialog through `useMapReplace`.
 */

import { useTranslation } from "react-i18next";
import { ClubMapImportState } from "./ClubMapImportState";
import { formatBytes } from "../lib/editor/map-info";
import type { MapReplace } from "./useMapReplace";

export function ClubMapPicker({ library }: { library: MapReplace["library"] }) {
  const { t } = useTranslation("dashboard");
  const { t: tl } = useTranslation("library");
  if (!library.open) return null;
  return (
    <div data-testid="club-map-picker" className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">{tl("pickerTitle")}</h2>
          <button type="button" className="text-sm text-slate-500 cursor-pointer" onClick={() => library.setOpen(false)}>
            {tl("cancel")}
          </button>
        </div>
        <ul className="divide-y divide-slate-100 max-h-80 overflow-auto">
          {library.maps.map((m) => (
            <li key={m.id}>
              {/* A series without a version cannot be adopted (06 §6). */}
              <button
                type="button"
                data-testid={`club-map-pick-${m.id}`}
                className="w-full text-left py-2 px-1 hover:bg-slate-50 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                disabled={m.version == null}
                title={m.version == null ? tl("notImportedYet") : undefined}
                onClick={() => library.pick(m.id)}
              >
                <div className="font-medium text-sm text-slate-900">{m.name}</div>
                <div className="text-xs text-slate-500">
                  {m.scale
                    ? `1:${Math.round(m.scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`
                    : tl("noScale")}
                  {m.sizeBytes != null && <>{" · "}{formatBytes(m.sizeBytes)}</>}
                </div>
                {m.version == null && <ClubMapImportState job={m.importJob} className="text-xs" />}
              </button>
            </li>
          ))}
        </ul>
        {library.pending && <p className="text-xs text-blue-600">{t("uploading")}</p>}
      </div>
    </div>
  );
}

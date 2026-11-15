/**
 * Map mode's symbol picker (docs/course-editor.md §13 "Symbol picker"; map-symbols.md §11.2): the palette cut to one
 * kind, searchable, with swatches; a disabled item names the colours the map lacks. Picking is the caller's: the
 * drawing tool's symbol, or *Change symbol*'s write.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { mapDocument } from "@oxygen/shared";
import { swatchUrl } from "../../../../lib/editor/symbol-groups";
import { itemKey, itemName, paletteSwatch, paletteView, type PaletteKind } from "./palette";

export function SymbolPicker({ groups, kind, query, onQuery, pressed, onPick, documentHash, nameId, hint }: {
  groups: readonly mapDocument.PaletteGroup[];
  kind: PaletteKind;
  query: string;
  onQuery: (q: string) => void;
  /** The item key shown pressed: the tool's chosen symbol, or the object's effective one. */
  pressed: string | null;
  onPick: (item: mapDocument.PaletteItem) => void;
  documentHash: string;
  nameId: string;
  /** Shown above the list (the tool's gestures, or "pick a symbol"). */
  hint?: { testId: string; text: string } | null;
}) {
  const { t, i18n } = useTranslation("editor");
  const view = useMemo(() => paletteView(groups, kind, query), [groups, kind, query]);
  const lang = i18n.language;
  return (
    <div data-testid="editor-map-palette" data-kind={kind} className="flex flex-col gap-1.5 px-2.5 py-2 text-xs min-h-0">
      {hint && <p data-testid={hint.testId} className="text-[11px] text-slate-500">{hint.text}</p>}
      <input data-testid="editor-map-palette-search" type="search" value={query} placeholder={t("mapPaletteSearch")} aria-label={t("mapPaletteSearch")}
        onChange={(e) => onQuery(e.target.value)}
        className="w-full px-1.5 py-1 border border-slate-200 rounded-md bg-white text-xs" />
      <div className="max-h-72 overflow-y-auto flex flex-col gap-2">
        {view.length === 0 && <p data-testid="editor-map-palette-none" className="text-[11px] text-slate-500">{t("mapPaletteNone")}</p>}
        {view.map((g) => (
          <div key={g.id} data-testid="editor-map-palette-group" data-group={g.id} className="flex flex-col">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 py-0.5">
              {g.id === "library" ? g.library ?? "" : t(`mapPaletteGroup_${g.id}`)}
            </div>
            {g.headings.flatMap((h) => h.entries.map((item) => {
              const key = itemKey(item);
              const src = swatchUrl(paletteSwatch(item), documentHash, nameId);
              const name = itemName(item, lang);
              const title = item.enabled ? `${item.code} ${name}` : t("mapPaletteMissing", { colours: (item.missing ?? []).join(", ") });
              return (
                <button key={key} type="button" data-testid="editor-map-palette-item" data-ref={key} data-source={item.source} data-kind={item.kind}
                  data-code={item.code} data-objects={item.objects} aria-pressed={pressed === key} disabled={!item.enabled} title={title}
                  onClick={() => onPick(item)}
                  className={`flex items-center gap-2 px-1 py-0.5 rounded text-left min-w-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${pressed === key ? "bg-purple-100 text-purple-800" : "hover:bg-slate-50"}`}>
                  {src
                    ? <img data-testid="editor-map-palette-swatch" src={src} alt="" loading="lazy" className="w-5 h-5 shrink-0 rounded border border-slate-200 bg-white object-contain" />
                    : <span data-testid="editor-map-palette-swatch" className="w-5 h-5 shrink-0 rounded border border-dashed border-slate-300" />}
                  <span className="font-mono text-slate-500 shrink-0">{item.code}</span>
                  <span className="truncate">{name}</span>
                </button>
              );
            }))}
          </div>
        ))}
      </div>
    </div>
  );
}

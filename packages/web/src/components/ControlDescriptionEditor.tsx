import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlDescription } from "@oxygen/shared";
import { IOF_SYMBOLS, getDescriptionSymbols } from "../iof-symbols";
import { iofSymbolName } from "../iof-symbol-meta";
import {
  C_OPTIONS,
  D_GROUPS,
  F_OPTIONS,
  G_DIRECTIONAL,
  G_PLAIN,
  ocadToIof,
  type DescriptionOption,
} from "../lib/control-description-options";

/**
 * Modal editor for a control's IOF description (stored on the control
 * row in the OCAD text encoding). Symbol pickers per sheet column —
 * C (which of similar), D (feature), E (dimensions, free text),
 * F (combination), G (flag location) — with a live preview row.
 *
 * Editing writes canonical OCAD codes; untouched fields keep whatever
 * encoding the OCD importer stored (both render identically).
 */

type SymbolField = "c" | "d" | "f" | "g";

interface Props {
  /** Punch code shown in the header and preview row. */
  controlCode: string;
  initial: ControlDescription | null;
  onSave: (desc: ControlDescription | null) => void;
  onCancel: () => void;
}

function SymbolButton({
  option,
  selected,
  name,
  onClick,
}: {
  option: DescriptionOption;
  selected: boolean;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-pressed={selected}
      data-testid={`desc-opt-${option.iof}`}
      onClick={onClick}
      className={`w-9 h-9 shrink-0 rounded border flex items-center justify-center transition-colors cursor-pointer ${
        selected
          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-300"
          : "border-slate-200 hover:bg-slate-100"
      }`}
    >
      {/* Static generated SVG fragments from svg-control-descriptions — same
          rendering path as the map's description sheet. */}
      <svg
        viewBox="-100 -100 200 200"
        className="w-7 h-7"
        dangerouslySetInnerHTML={{ __html: IOF_SYMBOLS[option.iof] }}
      />
    </button>
  );
}

export function ControlDescriptionEditor({ controlCode, initial, onSave, onCancel }: Props) {
  const { t, i18n } = useTranslation("controls");
  const [desc, setDesc] = useState<ControlDescription>(() => ({ ...(initial ?? {}) }));

  // Swallow Escape before the editor page's global handler clears the
  // map selection underneath the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  const selectedIof = useMemo(
    () => ({
      c: desc.c ? ocadToIof("c", desc.c) : null,
      d: desc.d ? ocadToIof("d", desc.d) : null,
      f: desc.f ? ocadToIof("f", desc.f) : null,
      g: desc.g ? ocadToIof("g", desc.g) : null,
    }),
    [desc],
  );

  const setField = useCallback((field: SymbolField, opt: DescriptionOption, selected: boolean) => {
    setDesc((prev) => {
      const next = { ...prev };
      if (selected) delete next[field];
      else next[field] = opt.ocad;
      return next;
    });
  }, []);

  const preview = useMemo(() => getDescriptionSymbols(desc), [desc]);
  const isEmpty = Object.values(desc).every((v) => !v);

  const renderOptions = (field: SymbolField, options: DescriptionOption[]) => (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const selected = selectedIof[field] === opt.iof;
        return (
          <SymbolButton
            key={opt.iof}
            option={opt}
            selected={selected}
            name={iofSymbolName(opt.iof, i18n.language)}
            onClick={() => setField(field, opt, selected)}
          />
        );
      })}
    </div>
  );

  const sectionTitle = (label: string) => (
    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-4 mb-1.5 first:mt-0">
      {label}
    </h3>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        data-testid="desc-editor"
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
      >
        {/* Header + live preview row */}
        <div className="px-5 pt-4 pb-3 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-800 mb-2.5">
            {t("descEditor.title", { code: controlCode })}
          </h2>
          <div data-testid="desc-preview" className="flex border border-slate-400 w-fit">
            {(["code", "colC", "colD", "colE", "colF", "colG"] as const).map((col) => (
              <div
                key={col}
                className="w-9 h-9 border-r border-slate-300 last:border-r-0 flex items-center justify-center text-sm font-semibold text-slate-800"
              >
                {col === "code" ? (
                  controlCode
                ) : col === "colE" ? (
                  <span className="text-xs">{preview.colE}</span>
                ) : preview[col] ? (
                  <svg
                    viewBox="-100 -100 200 200"
                    className="w-7 h-7"
                    dangerouslySetInnerHTML={{ __html: preview[col]! }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {/* Pickers */}
        <div className="px-5 py-4 overflow-y-auto">
          {sectionTitle(t("descEditor.columnC"))}
          {renderOptions("c", C_OPTIONS)}

          {sectionTitle(t("descEditor.columnD"))}
          <div className="space-y-2">
            {D_GROUPS.map(({ group, options }) => (
              <div key={group}>
                <div className="text-[11px] text-slate-400 mb-0.5">
                  {t(`descEditor.dGroup${group}` as "descEditor.dGroup1")}
                </div>
                {renderOptions("d", options)}
              </div>
            ))}
          </div>

          {sectionTitle(t("descEditor.columnE"))}
          <input
            type="text"
            data-testid="desc-dim-input"
            value={desc.s ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setDesc((prev) => {
                const next = { ...prev };
                if (v) next.s = v;
                else delete next.s;
                return next;
              });
            }}
            placeholder={t("descEditor.dimensionsPlaceholder")}
            className="w-40 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          {sectionTitle(t("descEditor.columnF"))}
          {renderOptions("f", F_OPTIONS)}

          {sectionTitle(t("descEditor.columnG"))}
          <div className="space-y-1">
            {G_DIRECTIONAL.map(({ iofBase, byDirection }) => (
              <div key={iofBase}>{renderOptions("g", byDirection)}</div>
            ))}
            <div>{renderOptions("g", G_PLAIN)}</div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-2">
          <button
            type="button"
            data-testid="desc-clear"
            onClick={() => setDesc({})}
            disabled={isEmpty}
            className="px-3 py-1.5 text-sm text-slate-500 hover:text-red-600 disabled:opacity-40 disabled:hover:text-slate-500 rounded-lg hover:bg-red-50 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-default"
          >
            {t("descEditor.clearAll")}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="desc-cancel"
            onClick={onCancel}
            className="px-4 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            {t("descEditor.cancel")}
          </button>
          <button
            type="button"
            data-testid="desc-save"
            onClick={() => onSave(isEmpty ? null : desc)}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {t("descEditor.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

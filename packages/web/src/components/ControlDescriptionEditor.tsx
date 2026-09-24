import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlDescription } from "@oxygen/shared";
import { IOF_SYMBOLS, descriptionCells } from "../iof-symbols";
import { iofSymbolName } from "../iof-symbol-meta";
import {
  C_OPTIONS,
  COMPASS_DIRECTIONS,
  D_GROUPS,
  E_OPTIONS,
  F_OPTIONS,
  G_DIRECTIONAL,
  G_PLAIN,
  H_OPTIONS,
  ocadToIof,
  type DescriptionOption,
} from "../lib/control-description-options";

/**
 * Modal editor for a control's IOF description (stored on the control
 * row in the OCAD text encoding). Symbol pickers per sheet column —
 * C (which of similar), D (feature), E (appearance / 2nd feature),
 * F (dimensions + combination), G (flag location), H (other info) —
 * with a live preview row and written symbol titles (mobile-friendly).
 */

type SymbolField = "c" | "d" | "e" | "f" | "g" | "h";

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
  showLabel,
}: {
  option: DescriptionOption;
  selected: boolean;
  name: string;
  onClick: () => void;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-pressed={selected}
      data-testid={`desc-opt-${option.iof}`}
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 shrink-0 rounded border transition-colors cursor-pointer ${
        showLabel ? "p-1 min-w-[4.5rem]" : "w-9 h-9"
      } ${
        selected
          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-300"
          : "border-slate-200 hover:bg-slate-100"
      }`}
    >
      <svg
        viewBox="-100 -100 200 200"
        className={showLabel ? "w-7 h-7" : "w-7 h-7"}
        dangerouslySetInnerHTML={{ __html: IOF_SYMBOLS[option.iof] }}
      />
      {showLabel && (
        <span
          data-testid={`desc-opt-label-${option.iof}`}
          className="text-[10px] leading-tight text-slate-600 text-center max-w-[4.5rem] px-0.5"
        >
          {name}
        </span>
      )}
    </button>
  );
}

function composeSummary(
  desc: ControlDescription,
  language: string,
): string {
  const parts: string[] = [];
  const push = (field: SymbolField, code?: string) => {
    if (!code) return;
    const iof = ocadToIof(field, code);
    if (iof) parts.push(iofSymbolName(iof, language));
  };
  push("c", desc.c);
  push("d", desc.d);
  push("e", desc.e);
  if (desc.s) parts.push(desc.s.replace(",", "."));
  push("f", desc.f);
  push("g", desc.g);
  push("h", desc.h);
  return parts.join(" · ");
}

export function ControlDescriptionEditor({ controlCode, initial, onSave, onCancel }: Props) {
  const { t, i18n } = useTranslation("controls");
  const [desc, setDesc] = useState<ControlDescription>(() => ({ ...(initial ?? {}) }));
  const [showSecondFeature, setShowSecondFeature] = useState(
    () => !!(initial?.e && !String(initial.e).startsWith("8.")),
  );
  const [announce, setAnnounce] = useState("");

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
      e: desc.e ? ocadToIof("e", desc.e) : null,
      f: desc.f ? ocadToIof("f", desc.f) : null,
      g: desc.g ? ocadToIof("g", desc.g) : null,
      h: desc.h ? ocadToIof("h", desc.h) : null,
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
    setAnnounce(iofSymbolName(opt.iof, i18n.language));
  }, [i18n.language]);

  const preview = useMemo(() => descriptionCells(desc), [desc]);
  const summary = useMemo(
    () => composeSummary(desc, i18n.language),
    [desc, i18n.language],
  );
  const isEmpty = Object.values(desc).every((v) => !v);

  const cCompass = C_OPTIONS.slice(0, 8);
  const cExtra = C_OPTIONS.slice(8);

  const renderOptions = (
    field: SymbolField,
    options: DescriptionOption[],
    { showLabel = false }: { showLabel?: boolean } = {},
  ) => (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const selected = selectedIof[field] === opt.iof;
        return (
          <SymbolButton
            key={opt.iof}
            option={opt}
            selected={selected}
            name={iofSymbolName(opt.iof, i18n.language)}
            showLabel={showLabel}
            onClick={() => setField(field, opt, selected)}
          />
        );
      })}
    </div>
  );

  const sectionTitle = (label: string, selectedName?: string | null) => (
    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-4 mb-1.5 first:mt-0 flex items-baseline gap-2 flex-wrap">
      <span>{label}</span>
      {selectedName && (
        <span className="normal-case tracking-normal font-medium text-slate-700">
          — {selectedName}
        </span>
      )}
    </h3>
  );

  const selectedName = (field: SymbolField) => {
    const key = selectedIof[field];
    return key ? iofSymbolName(key, i18n.language) : null;
  };

  // Column C compass grid: NW N NE / W · E / SW S SE matching map north-up.
  const cByDir = new Map(
    cCompass.map((o) => {
      const dir = COMPASS_DIRECTIONS.find((d) => o.iof.endsWith(d));
      return [dir, o] as const;
    }),
  );
  const cGridOrder: Array<string | null> = [
    "NW", "N", "NE",
    "W", null, "E",
    "SW", "S", "SE",
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        data-testid="desc-editor"
        className="bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col"
      >
        <div className="px-5 pt-4 pb-3 border-b border-slate-200 sticky top-0 bg-white z-10 rounded-t-xl">
          <h2 className="text-base font-semibold text-slate-800 mb-2.5">
            {t("descEditor.title", { code: controlCode })}
          </h2>
          <div data-testid="desc-preview" className="flex border border-slate-400 w-fit">
            {(["code", "C", "D", "E", "F", "G", "H"] as const).map((col) => (
              <div
                key={col}
                className="w-9 h-9 border-r border-slate-300 last:border-r-0 flex items-center justify-center text-sm font-semibold text-slate-800"
              >
                {col === "code" ? (
                  controlCode
                ) : (() => {
                  const cell = preview[col];
                  if (!cell) return null;
                  if (cell.kind === "text") {
                    return <span className="text-xs">{cell.text}</span>;
                  }
                  return (
                    <svg
                      viewBox="-100 -100 200 200"
                      className="w-7 h-7"
                      dangerouslySetInnerHTML={{ __html: cell.svg }}
                    />
                  );
                })()}
              </div>
            ))}
          </div>
          <p
            data-testid="desc-summary"
            className="mt-2 text-sm text-slate-600 min-h-[1.25rem]"
            aria-live="polite"
          >
            {summary || <span className="text-slate-400">{t("descEditor.emptySummary")}</span>}
          </p>
          <span className="sr-only" aria-live="assertive">{announce}</span>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {sectionTitle(t("descEditor.columnC"), selectedName("c"))}
          <div data-testid="desc-section-c">
          <div
            data-testid="desc-c-grid"
            className="grid grid-cols-3 gap-1.5 w-fit mb-2"
          >
            {cGridOrder.map((dir, i) => {
              if (!dir) {
                return <div key={`empty-${i}`} className="w-[4.5rem]" />;
              }
              const opt = cByDir.get(dir as never);
              if (!opt) return null;
              const selected = selectedIof.c === opt.iof;
              return (
                <SymbolButton
                  key={opt.iof}
                  option={opt}
                  selected={selected}
                  name={iofSymbolName(opt.iof, i18n.language)}
                  showLabel
                  onClick={() => setField("c", opt, selected)}
                />
              );
            })}
          </div>
          {renderOptions("c", cExtra, { showLabel: true })}
          </div>

          {sectionTitle(t("descEditor.columnD"), selectedName("d"))}
          <div data-testid="desc-section-d" className="space-y-2">
            {D_GROUPS.map(({ group, options }) => (
              <div key={group}>
                <div className="text-[11px] text-slate-400 mb-0.5">
                  {t(`descEditor.dGroup${group}` as "descEditor.dGroup1")}
                </div>
                {renderOptions("d", options)}
              </div>
            ))}
          </div>

          {sectionTitle(t("descEditor.columnE"), selectedName("e"))}
          <div data-testid="desc-section-e">
          <p className="text-[11px] text-slate-400 mb-1">{t("descEditor.appearanceHint")}</p>
          {renderOptions("e", E_OPTIONS, { showLabel: true })}
          <button
            type="button"
            data-testid="desc-second-feature-toggle"
            onClick={() => setShowSecondFeature((v) => !v)}
            className="mt-2 text-xs text-blue-600 hover:underline cursor-pointer"
          >
            {showSecondFeature
              ? t("descEditor.hideSecondFeature")
              : t("descEditor.showSecondFeature")}
          </button>
          {showSecondFeature && (
            <div
              data-testid="desc-section-e-second"
              className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3"
            >
              <p className="text-[11px] text-slate-400">{t("descEditor.secondFeatureHint")}</p>
              {D_GROUPS.map(({ group, options }) => (
                <div key={`e2-${group}`}>
                  <div className="text-[11px] text-slate-400 mb-0.5">
                    {t(`descEditor.dGroup${group}` as "descEditor.dGroup1")}
                  </div>
                  {renderOptions("e", options)}
                </div>
              ))}
            </div>
          )}
          </div>

          {sectionTitle(t("descEditor.columnF"), selectedName("f") ?? (desc.s ? desc.s : null))}
          <div data-testid="desc-section-f">
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
            className="w-40 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
          />
          <p className="text-[11px] text-slate-400 mb-1">{t("descEditor.combinationHint")}</p>
          {renderOptions("f", F_OPTIONS, { showLabel: true })}
          </div>

          {sectionTitle(t("descEditor.columnG"), selectedName("g"))}
          <div data-testid="desc-section-g" className="space-y-1">
            {G_DIRECTIONAL.map(({ iofBase, byDirection }) => (
              <div key={iofBase}>{renderOptions("g", byDirection)}</div>
            ))}
            <div>{renderOptions("g", G_PLAIN, { showLabel: true })}</div>
          </div>

          {sectionTitle(t("descEditor.columnH"), selectedName("h"))}
          <div data-testid="desc-section-h">
          {renderOptions("h", H_OPTIONS, { showLabel: true })}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 sticky bottom-0 bg-white rounded-b-xl">
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

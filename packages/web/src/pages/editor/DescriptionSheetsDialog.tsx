/**
 * *Description sheets…* (docs/course-print.md §6.4; docs/course-layout.md §7):
 * the dialog behind Export ▾'s entry in the editor and the Courses page's
 * export menu. Classes (every class with a course checked by default),
 * copies (runners + vacancies, one full sheet, or a number) and the cell
 * size → `descriptions.pdf`. A modal like the map-info dialog: portalled to
 * the fullscreen element or the body, focus on the first control when it
 * opens and Tab kept inside it, and no keydown reaches the editor's
 * shortcuts while it is open (Escape closes it).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  DESCRIPTION_SHEET_CELLS,
  DESCRIPTION_SHEET_DEFAULT_CELL,
  DESCRIPTION_SHEET_MAX_COPIES,
  type DescriptionCopies,
  type DescriptionSheetCell,
} from "@oxygen/shared";
import { trpc } from "../../lib/trpc";
import { downloadSameOriginFile } from "../../lib/download-api";
import { descriptionSheetsUrl } from "../../lib/editor/export-menu";

type CopiesMode = "count" | "fill" | "n";
const MAX_COPIES = DESCRIPTION_SHEET_MAX_COPIES;

export function DescriptionSheetsDialog({ nameId, onClose }: { nameId: string; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const classes = trpc.class.list.useQuery();
  // Class order as the route's default: sort index, then seq.
  const withCourse = useMemo(
    () => (classes.data ?? []).filter((c) => c.courseIds.length > 0).sort((a, b) => a.sortIndex - b.sortIndex || a.id - b.id),
    [classes.data],
  );
  const [checked, setChecked] = useState<Set<number> | null>(null);
  const [mode, setMode] = useState<CopiesMode>("count");
  const [n, setN] = useState(1);
  const [cell, setCell] = useState<DescriptionSheetCell>(DESCRIPTION_SHEET_DEFAULT_CELL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = "editor-descriptions-title";
  const boxRef = useRef<HTMLDivElement>(null);

  // Every class with a course, once the list has loaded.
  const selected = checked ?? new Set(withCourse.map((c) => c.id));

  // A modal (the map-info dialog's rule): no keydown reaches the editor's handlers (window, capture phase), Escape
  // closes, Tab cycles inside the dialog and never reaches the page under the backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Tab") {
        const items = boxRef.current ? [...boxRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")] : [];
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
        e.preventDefault();
        items[next].focus();
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  useEffect(() => { boxRef.current?.querySelector<HTMLElement>("input, select, button")?.focus(); }, []);

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };
  const nValid = Number.isInteger(n) && n >= 1 && n <= MAX_COPIES;
  const ordered = withCourse.filter((c) => selected.has(c.id)).map((c) => c.id);
  const canDownload = !busy && ordered.length > 0 && (mode !== "n" || nValid);

  const download = async () => {
    const copies: DescriptionCopies = mode === "n" ? n : mode;
    setBusy(true);
    setError(null);
    try {
      await downloadSameOriginFile(descriptionSheetsUrl(nameId, { classSeqs: ordered, copies, cell }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const radio = "accent-purple-600 cursor-pointer";
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" aria-label={t("descriptionSheetsCancel")} tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/40 cursor-default" />
      <div ref={boxRef} data-testid="editor-descriptions-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-white rounded-xl shadow-lg w-full max-w-md max-h-[calc(100%-2rem)] overflow-auto text-sm">
        <div className="px-5 pt-4 pb-3 border-b border-slate-100">
          <h2 id={titleId} className="font-semibold text-slate-900">{t("descriptionSheetsTitle")}</h2>
          <p className="text-xs text-slate-500">{t("descriptionSheetsHint")}</p>
        </div>

        <div className="px-5 py-3 space-y-4">
          <fieldset data-testid="editor-descriptions-classes">
            <legend className="mb-1 text-xs font-medium text-slate-600">{t("descriptionSheetsClasses")}</legend>
            {classes.isLoading ? (
              <p className="text-xs text-slate-500">…</p>
            ) : withCourse.length === 0 ? (
              <p data-testid="editor-descriptions-no-classes" className="text-xs text-slate-500">{t("descriptionSheetsNoClasses")}</p>
            ) : (
              <>
                <div className="mb-1 flex gap-3 text-xs">
                  <button type="button" data-testid="editor-descriptions-all" onClick={() => setChecked(new Set(withCourse.map((c) => c.id)))} className="text-purple-700 hover:underline cursor-pointer">{t("descriptionSheetsAll")}</button>
                  <button type="button" data-testid="editor-descriptions-none" onClick={() => setChecked(new Set())} className="text-purple-700 hover:underline cursor-pointer">{t("descriptionSheetsNone")}</button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 max-h-48 overflow-auto">
                  {withCourse.map((c) => (
                    <label key={c.id} className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer min-w-0">
                      <input type="checkbox" data-testid={`editor-descriptions-class-${c.id}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} className={radio} />
                      <span className="truncate" title={`${c.name} · ${c.courseName}`}>{c.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </fieldset>

          <fieldset data-testid="editor-descriptions-copies" className="space-y-1 text-xs text-slate-700">
            <legend className="mb-1 font-medium text-slate-600">{t("descriptionSheetsCopies")}</legend>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="descriptions-copies" data-testid="editor-descriptions-copies-count" checked={mode === "count"} onChange={() => setMode("count")} className={radio} />
              {t("descriptionSheetsCopiesCount")}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="descriptions-copies" data-testid="editor-descriptions-copies-fill" checked={mode === "fill"} onChange={() => setMode("fill")} className={radio} />
              {t("descriptionSheetsCopiesFill")}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="descriptions-copies" data-testid="editor-descriptions-copies-n" checked={mode === "n"} onChange={() => setMode("n")} className={radio} />
              {t("descriptionSheetsCopiesN")}
              <input type="number" min={1} max={MAX_COPIES} step={1} value={Number.isFinite(n) ? n : ""} data-testid="editor-descriptions-copies-value"
                aria-label={t("descriptionSheetsCopiesN")}
                onChange={(e) => { setN(e.target.valueAsNumber); setMode("n"); }}
                className={`w-16 rounded border px-1.5 py-0.5 ${mode === "n" && !nValid ? "border-red-400" : "border-slate-200"}`} />
            </label>
          </fieldset>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <span className="font-medium text-slate-600">{t("descriptionSheetsCell")}</span>
            <select data-testid="editor-descriptions-cell" value={cell} onChange={(e) => setCell(Number(e.target.value) as DescriptionSheetCell)}
              className="rounded border border-slate-200 px-1.5 py-0.5 cursor-pointer">
              {DESCRIPTION_SHEET_CELLS.map((c) => <option key={c} value={c}>{c} mm</option>)}
            </select>
          </label>

          {error && <p data-testid="editor-descriptions-error" className="text-xs text-red-600 break-words">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button type="button" data-testid="editor-descriptions-cancel" onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">
            {t("descriptionSheetsCancel")}
          </button>
          <button type="button" data-testid="editor-descriptions-download" disabled={!canDownload} onClick={() => void download()}
            className="px-3 py-1.5 text-xs rounded-lg bg-purple-600 text-white hover:bg-purple-700 cursor-pointer disabled:opacity-50 disabled:cursor-default">
            {busy ? t("exportBusy") : t("descriptionSheetsDownload")}
          </button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}

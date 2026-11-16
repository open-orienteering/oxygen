/**
 * *Save corrections to the club map*'s confirm dialog (docs/course-editor.md §13 "Promote"; map-patches §5 answer 6:
 * promote is not an undo entry, so it asks first): the label, prefilled by the caller, and the count that applies.
 */

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { promoteLabel, PROMOTE_LABEL_MAX } from "./promote";

export function PromoteDialog({ label, count, onLabel, onCancel, onConfirm }: {
  label: string;
  count: number;
  onLabel: (label: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("editor");
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const valid = promoteLabel(label) !== null;
  // Portalled as the editor's other dialogs: into the fullscreen element when there is one.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" aria-label={t("promoteCancel")} tabIndex={-1} onClick={onCancel} className="absolute inset-0 bg-black/40 cursor-default" />
      <form data-testid="editor-map-promote-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(); }}
        className="relative bg-white rounded-xl shadow-lg w-full max-w-md p-5 flex flex-col gap-3 text-sm">
        <h2 id={titleId} className="font-semibold text-slate-900">{t("promoteTitle")}</h2>
        <p className="text-slate-600 text-xs">{t("promoteBody", { count })}</p>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          {t("promoteLabel")}
          <input ref={inputRef} data-testid="editor-map-promote-label" value={label} maxLength={PROMOTE_LABEL_MAX} onChange={(e) => onLabel(e.target.value)}
            className="px-2 py-1 border border-slate-200 rounded-md text-sm text-slate-900" />
        </label>
        <p className="text-[11px] text-amber-800">{t("promoteNoUndo")}</p>
        <div className="flex justify-end gap-2">
          <button type="button" data-testid="editor-map-promote-cancel" onClick={onCancel}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">{t("promoteCancel")}</button>
          <button type="submit" data-testid="editor-map-promote-confirm" disabled={!valid}
            className="px-3 py-1.5 text-xs rounded-lg text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed">{t("promoteConfirm")}</button>
        </div>
      </form>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}

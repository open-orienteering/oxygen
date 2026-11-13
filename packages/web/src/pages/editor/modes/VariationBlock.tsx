/**
 * A variation group's block in the course sequence (docs/course-editor.md
 * §12; 08 §5.2 "variation groups as nested blocks with A/B tabs", §5.3):
 * the alternatives as tabs — the active one is displayed and edited, `1–9`
 * on the selection's group picks one — with *Add alternative*, remove and
 * rename of the active one and the *Loop* checkbox. A sequence row dragged
 * onto a tab moves into that alternative. On a phone only the tabs work
 * (08 §5.5: switching the displayed alternative); the rest is
 * desktop-optimised and says so. Presentational: every write is the page's.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { VariationBlockInfo } from "../../../lib/editor/sequence";

export interface VariationHandlers {
  /** The phone (08 §5.5): tabs only. */
  readOnly: boolean;
  onTab: (groupId: string, label: string) => void;
  onAdd: (groupId: string) => void;
  onRemove: (groupId: string, label: string) => void;
  onRename: (groupId: string, label: string, next: string) => void;
  onLoop: (groupId: string, loop: boolean) => void;
  /** A row (control-sequence position) dropped on an alternative's tab. */
  onMoveTo: (seqIndex: number, groupId: string, label: string) => void;
}

export function VariationBlock({ block, on, dragFrom, onDropped }: {
  block: VariationBlockInfo;
  on: VariationHandlers;
  /** The row being dragged (its control-sequence position), or null. */
  dragFrom: number | null;
  onDropped: () => void;
}) {
  const { t } = useTranslation("editor");
  const [renaming, setRenaming] = useState<string | null>(null);
  const edit = !on.readOnly;
  const commitRename = (label: string, value: string) => {
    setRenaming(null);
    if (value.trim() && value.trim() !== label) on.onRename(block.id, label, value);
  };
  return (
    <li data-testid="editor-variation" data-group={block.id} data-loop={block.loop ? "true" : undefined}
      className="mx-1.5 my-0.5 px-1.5 py-1 rounded-md border border-purple-200 bg-purple-50/50">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-purple-700">{block.loop ? t("variationLoopTitle") : t("variationTitle")}</span>
        <div className="flex gap-0.5" role="tablist" aria-label={t("variationAlternatives")}>
          {block.labels.map((label) => {
            const active = label === block.active;
            return renaming === label ? (
              <input key={label} autoFocus data-testid="editor-variation-label" defaultValue={label} aria-label={t("variationRename")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(label, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={(e) => commitRename(label, e.currentTarget.value)}
                className="w-10 px-1 py-0 border border-purple-300 rounded text-xs" />
            ) : (
              <button key={label} type="button" role="tab" data-testid={`editor-variation-tab-${label}`} aria-pressed={active} aria-selected={active}
                title={t("variationTabHint", { label, count: block.counts[label] ?? 0 })}
                onClick={() => on.onTab(block.id, label)}
                onDoubleClick={() => { if (edit) setRenaming(label); }}
                onDragOver={(e) => { if (edit && dragFrom !== null) e.preventDefault(); }}
                onDrop={() => { if (edit && dragFrom !== null) on.onMoveTo(dragFrom, block.id, label); onDropped(); }}
                className={`min-w-[1.5rem] px-1.5 py-0 rounded text-xs cursor-pointer border ${active ? "bg-purple-600 text-white border-purple-600" : "bg-white text-purple-700 border-purple-200 hover:bg-purple-100"}`}>
                {label}
                <span className="ml-0.5 text-[9px] opacity-70 tabular-nums">{block.counts[label] ?? 0}</span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" data-testid="editor-variation-add" disabled={!edit} title={t("variationAdd")} aria-label={t("variationAdd")}
            onClick={() => on.onAdd(block.id)} className="px-1 text-purple-700 disabled:opacity-40 cursor-pointer">＋</button>
          <button type="button" data-testid="editor-variation-rename" disabled={!edit} title={t("variationRename")} aria-label={t("variationRename")}
            onClick={() => setRenaming(block.active)} className="px-1 text-purple-700 disabled:opacity-40 cursor-pointer">✎</button>
          <button type="button" data-testid="editor-variation-remove" disabled={!edit}
            title={block.labels.length > 2 ? t("variationRemove", { label: block.active }) : t("variationDissolve", { label: block.active })}
            aria-label={t("variationRemove", { label: block.active })}
            onClick={() => on.onRemove(block.id, block.active)} className="px-1 text-red-500 disabled:opacity-40 cursor-pointer">✕</button>
        </span>
      </div>
      <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-600" title={t("variationLoopHint")}>
        <input type="checkbox" data-testid="editor-variation-loop" checked={block.loop} disabled={!edit}
          onChange={(e) => on.onLoop(block.id, e.target.checked)} />
        {t("variationLoop")}
      </label>
      {on.readOnly && <p data-testid="editor-variation-readonly" className="mt-0.5 text-[10px] text-slate-400 leading-snug">{t("variationReadOnly")}</p>}
    </li>
  );
}

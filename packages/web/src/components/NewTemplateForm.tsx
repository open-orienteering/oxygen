/**
 * "New template" (E-pages; docs/course-layout.md §2, docs/course-maps.md):
 * paper, orientation, print scale and margin, the name defaulting to the
 * key's name (`A4 portrait 1:10000`). The server's key rule makes the new
 * template its key's auto template unless the key has one (then extra).
 * Used by Layout mode's template section and the Courses page's picker.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EMPTY_TEMPLATE_DRAFT, newTemplatePayload, type NewTemplatePayload, type TemplateDraft } from "../lib/course-map-types";

const FIELD = "w-full px-2 py-1 border border-slate-200 rounded-md bg-white text-xs text-slate-700";

export function NewTemplateForm({ onSubmit, onCancel, busy = false }: {
  onSubmit: (payload: NewTemplatePayload) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation("courses");
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE_DRAFT);
  const set = <K extends keyof TemplateDraft>(k: K, v: TemplateDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const placeholder = newTemplatePayload({ ...draft, name: "" }).name;
  return (
    <form data-testid="new-template-form" className="space-y-1.5"
      onSubmit={(e) => { e.preventDefault(); onSubmit(newTemplatePayload(draft)); }}>
      <label className="block text-[11px] text-slate-500">
        {t("templateName")}
        <input data-testid="new-template-name" value={draft.name} placeholder={placeholder} onChange={(e) => set("name", e.target.value)} className={FIELD} />
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block text-[11px] text-slate-500">
          {t("paper")}
          <select data-testid="new-template-paper" value={draft.paper} onChange={(e) => set("paper", e.target.value as TemplateDraft["paper"])} className={FIELD}>
            {(["A3", "A4", "A5"] as const).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="block text-[11px] text-slate-500">
          {t("orientation")}
          <select data-testid="new-template-orientation" value={draft.orientation} onChange={(e) => set("orientation", e.target.value as TemplateDraft["orientation"])} className={FIELD}>
            <option value="portrait">{t("portrait")}</option>
            <option value="landscape">{t("landscape")}</option>
          </select>
        </label>
        <label className="block text-[11px] text-slate-500">
          {t("printScale")}
          <input data-testid="new-template-scale" type="number" min={1000} max={100000} step={500} list="new-template-scales" value={draft.printScale}
            onChange={(e) => set("printScale", e.target.value)} className={`${FIELD} tabular-nums`} />
        </label>
        <label className="block text-[11px] text-slate-500">
          {t("margin")}
          <input data-testid="new-template-margin" type="number" min={0} max={50} step={0.5} value={draft.margin}
            onChange={(e) => set("margin", e.target.value)} className={`${FIELD} tabular-nums`} />
        </label>
      </div>
      <datalist id="new-template-scales">
        {[4000, 5000, 7500, 10000, 15000].map((v) => <option key={v} value={v} />)}
      </datalist>
      <div className="flex gap-2 pt-0.5">
        <button type="submit" data-testid="new-template-submit" disabled={busy}
          className="px-2.5 py-1 rounded-md bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 cursor-pointer disabled:opacity-50">
          {t("createTemplate")}
        </button>
        <button type="button" data-testid="new-template-cancel" onClick={onCancel}
          className="px-2.5 py-1 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 cursor-pointer">
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

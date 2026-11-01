/**
 * The inspector (docs/course-editor.md §2; 08 §5.2): collapsible sections
 * — the mode's own (Course mode: course and sequence, selection), the club
 * inventory and the Checks placeholder (D6). It floats in `MapPanel`'s
 * in-map strip so it stays visible in fullscreen.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { buildInventoryView } from "../../lib/course-editor";

export function InspectorSection({ title, testId, defaultOpen = true, children, aside }: {
  title: string; testId: string; defaultOpen?: boolean; children: ReactNode; aside?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section data-testid={testId} data-open={open ? "true" : "false"} className="border-b border-slate-100 last:border-b-0 min-h-0 flex flex-col">
      <button type="button" onClick={() => setOpen((v) => !v)} data-testid={`${testId}-toggle`}
        className="shrink-0 w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-slate-600 hover:bg-slate-50 cursor-pointer">
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
        <span className="font-medium">{title}</span>
        {aside && <span className="ml-auto truncate max-w-[8rem] text-slate-400">{aside}</span>}
      </button>
      {open && <div className="min-h-0 flex flex-col">{children}</div>}
    </section>
  );
}

export function Inspector({ children }: { children: ReactNode }) {
  return (
    <div data-testid="editor-inspector"
      className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm text-xs w-64 min-h-0 max-h-full flex flex-col overflow-y-auto">
      {children}
    </div>
  );
}

type Inventory = ReturnType<typeof buildInventoryView>;

export function InventorySection({ inventory, activeSeriesId, onSeries }: {
  inventory: Inventory; activeSeriesId: string | null; onSeries: (id: string | null) => void;
}) {
  const { t } = useTranslation("courses");
  if (inventory.length === 0) return null;
  const active = inventory.find((s) => s.seriesId === activeSeriesId);
  return (
    <InspectorSection title={t("editor.inventory")} testId="editor-inventory-panel" defaultOpen={false} aside={active?.seriesName ?? t("editor.allocAuto")}>
      <div className="max-h-56 overflow-y-auto px-2.5 pb-2 space-y-2">
        <label className="block text-[11px] text-slate-500">
          {t("editor.allocFrom")}
          <select data-testid="editor-alloc-series" value={activeSeriesId ?? ""} onChange={(e) => onSeries(e.target.value || null)}
            className="mt-0.5 w-full px-1.5 py-1 border border-slate-200 rounded-md bg-white text-xs">
            <option value="">{t("editor.allocAuto")}</option>
            {inventory.map((s) => <option key={s.seriesId} value={s.seriesId}>{s.seriesName}</option>)}
          </select>
        </label>
        {inventory.map((series) => {
          const free = series.codes.filter((c) => !c.used).length;
          return (
            <div key={series.seriesId} className={series.seriesId === activeSeriesId ? "rounded-md bg-purple-50/70 -mx-1 px-1 py-0.5" : undefined}>
              <div className="flex items-center gap-1 text-[11px] text-slate-600">
                <span className="font-medium truncate">{series.seriesName}</span>
                {series.borrowed && <span className="rounded bg-amber-100 text-amber-800 px-1">{t("editor.borrowed")}</span>}
                <span className="ml-auto text-slate-400">{t("editor.inventoryFree", { free, total: series.codes.length })}</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {series.codes.map((code) => (
                  <span key={`${series.seriesId}-${code.code}`} data-testid={`editor-inventory-code-${code.code}`} data-used={code.used ? "true" : "false"}
                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 border ${code.used ? "bg-slate-200 border-slate-200 text-slate-500 line-through" : "bg-white border-slate-300 text-slate-700"}`}>
                    {code.code}
                    {code.type === "srr" && <span className="text-[8px] font-semibold text-amber-700">{t("editor.srrBadge")}</span>}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </InspectorSection>
  );
}

export function ChecksSection() {
  const { t } = useTranslation("editor");
  return (
    <InspectorSection title={t("checks")} testId="editor-checks" defaultOpen={false}>
      <p className="px-2.5 pb-2 text-slate-400">{t("checksLater")}</p>
    </InspectorSection>
  );
}

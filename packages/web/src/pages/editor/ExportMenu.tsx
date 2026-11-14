/**
 * Export ▾ in the editor's top bar (docs/course-layout.md §7; 08 §5.2):
 * `lib/editor/export-menu.ts` lists the entries; a map entry ensures the
 * sheets first (`layout.autoSheets`), then the file downloads from its
 * route; *Description sheets…* opens its dialog (course-print.md §6.4).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../../lib/trpc";
import { downloadExport } from "../../lib/download-api";
import { ensureSheetsBestEffort } from "../../lib/trpc-links";
import { exportEntries, type ExportEntry, type ExportState } from "../../lib/editor/export-menu";
import { formatStoredAt, offlinePrintErrorCode, useOfflinePrintProgress, useStoreMapsOffline } from "../../hooks/useOfflineMaps";
import { DescriptionSheetsDialog } from "./DescriptionSheetsDialog";
import { IconExport } from "../../components/map-icons";
import { TOP_BAR_TIER1_HIDE } from "../../components/top-bar-collapse";

const LABEL = {
  sheet: "exportSheet",
  course: "exportCourse",
  variant: "exportVariant",
  allVariations: "exportAllVariations",
  courseRunners: "exportCourseRunners",
  class: "exportClass",
  all: "exportAll",
  allControls: "exportAllControls",
  setter: "exportSetter",
  offline: "exportOffline",
  descriptions: "exportDescriptions",
  iofxml: "exportIofXml",
  ppen: "exportPpen",
} as const;

/** An `OfflinePrintError`'s message (G17, course-print.md §8.6 "Offline"); null for any other error. */
const OFFLINE_ERROR = { notStored: "exportNotStored", tooLarge: "exportTooLarge", unsupported: "exportOfflineUnsupported", failed: "exportOfflineFailed" } as const;

export function ExportMenu({ state, onError }: { state: ExportState; onError: (message: string) => void }) {
  const { t, i18n } = useTranslation("editor");
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [descriptions, setDescriptions] = useState(false);
  /** What the last export or store said beyond its file (G17): printed from the stored job, or what was stored. */
  const [notice, setNotice] = useState<string | null>(null);
  const storeOffline = useStoreMapsOffline(state.nameId, state.canEdit);
  const progress = useOfflinePrintProgress(state.nameId);
  const box = useRef<HTMLDivElement>(null);

  const message = (err: unknown): string => {
    const code = offlinePrintErrorCode(err);
    return code ? t(OFFLINE_ERROR[code]) : err instanceof Error ? err.message : String(err);
  };

  /** *Make maps available offline* (G17): the store step, its progress on the button. */
  const store = async () => {
    setBusy(true);
    try {
      const r = await storeOffline();
      if (r.status === "unsupported") onError(t("exportOfflineUnsupported"));
      else if (r.status === "offline") onError(t("exportOfflineNotOnline"));
      else if (r.status === "partial") onError(t("exportOfflinePartial"));
      else if (r.manifest) setNotice(t("exportOfflineStored", { count: r.manifest.queries.length, time: formatStoredAt(r.manifest.storedAt, i18n.language) }));
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const run = async (e: ExportEntry) => {
    setOpen(false);
    if (e.dialog === "descriptions") {
      setDescriptions(true);
      return;
    }
    setNotice(null);
    if (e.action === "offline") return store();
    setBusy(true);
    try {
      if (e.ensure) {
        const ensure = e.ensure;
        // Skipped on an offline venue box: it prints its copy's sheets (row G18).
        const r = await ensureSheetsBestEffort(() => utils.client.layout.autoSheets.mutate(ensure));
        if (r && (r.createdSheets.length || r.createdTemplates.length)) {
          void utils.courseMap.list.invalidate();
          void utils.mapTemplate.list.invalidate();
          void utils.layout.classOverrides.invalidate();
        }
      }
      // maps.pdf composes on the device when it can (course-print.md §8.6), offline from its stored job; other files download as they are.
      const out = await downloadExport(e.url);
      if (out.storedAt) setNotice(t("exportPrintedStored", { time: formatStoredAt(out.storedAt, i18n.language) }));
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  };

  // The silent run (Layout mode) shows only in the sync panel: the progress is the explicit action's.
  const label = busy && progress ? t("exportOfflineStoring", { done: progress.done, total: progress.total }) : busy ? t("exportBusy") : t("export");

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid="editor-export"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${label} ▾`}
        title={label}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 cursor-pointer disabled:opacity-50 disabled:cursor-default whitespace-nowrap"
      >
        {/* Icon + label (F29); the label is the first to go when the top bar's row is short. */}
        <span className="inline-flex shrink-0 [&>svg]:w-4 [&>svg]:h-4"><IconExport /></span>
        <span data-toolbar-label="" className={TOP_BAR_TIER1_HIDE}>{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-[12rem] rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {exportEntries(state).map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              data-testid={`editor-export-${e.id}`}
              disabled={e.disabled}
              onClick={() => void run(e)}
              className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-purple-50 cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              {e.id === "course" && e.labelValues ? t("exportCourseVariants", e.labelValues) : t(LABEL[e.id], e.labelValues ?? {})}
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div role="status" data-testid="editor-export-notice"
          className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 shadow">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="ml-2 cursor-pointer text-emerald-500 hover:text-emerald-700">{t("dismiss")}</button>
        </div>
      )}
      {descriptions && <DescriptionSheetsDialog nameId={state.nameId} onClose={() => setDescriptions(false)} />}
    </div>
  );
}

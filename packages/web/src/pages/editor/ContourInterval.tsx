/**
 * The map's contour interval in the editor (docs/course-elevation.md §0.43,
 * §4.4): what a person confirms so the contour-based climb can be stored.
 *
 * - `useContourInterval` reads `course.mapMetadata.contourInterval` and
 *   confirms or clears it (`course.setContourInterval`);
 * - `ContourIntervalRow` is the map info dialog's row
 *   (`editor-map-info-interval`): the number, its state, Confirm / Change,
 *   the club map note and the anchor's suspicion (a warning, never a source);
 * - `IntervalBanner` asks once while the map has contours and no confirmed
 *   interval (`editor-interval-banner`, dismissible, people who can edit);
 * - `openMapInfoAtInterval` opens the dialog from anywhere (the popover's
 *   Confirm, the banner).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCapabilities } from "../../context/CapabilitiesContext";
import { trpc } from "../../lib/trpc";

/** The values offered as suggestions; any value above 0 up to 100 with two decimals is accepted (§0.43). */
export const INTERVAL_SUGGESTIONS = [2, 2.5, 5, 10, 20, 25] as const;
const OPEN_MAP_INFO = "oxygen:open-map-info";

/** Opens the map info dialog (the top bar's `MapInfoButton` listens). */
export const openMapInfoAtInterval = (): void => { window.dispatchEvent(new CustomEvent(OPEN_MAP_INFO)); };

/** The map info button's listener. */
export function useOpenMapInfoRequest(open: () => void): void {
  useEffect(() => {
    window.addEventListener(OPEN_MAP_INFO, open);
    return () => window.removeEventListener(OPEN_MAP_INFO, open);
  }, [open]);
}

/** A value as typed: a comma is a decimal point; null when it is not a usable interval. */
export function parseInterval(text: string): number | null {
  const m = Number(text.trim().replace(",", "."));
  return Number.isFinite(m) && m > 0 && m <= 100 && Math.abs(m * 100 - Math.round(m * 100)) < 1e-6 ? m : null;
}

export function useContourInterval() {
  const utils = trpc.useUtils();
  const canEdit = useCapabilities().has("courses.edit");
  const meta = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const mutation = trpc.course.setContourInterval.useMutation({
    // The stored climbs were cleared and computed again on the server: everything that shows them is read again.
    onSuccess: async () => { await Promise.all([utils.course.mapMetadata.invalidate(), utils.course.list.invalidate(), utils.course.detail.invalidate()]); },
  });
  const data = meta.data?.contourInterval ?? null;
  const hasContours = meta.data?.terrain ? meta.data.terrain.state === "ready" || meta.data.terrain.state === "pending" : false;
  return {
    data, canEdit, hasContours,
    saving: mutation.isPending,
    error: mutation.error?.message ?? null,
    save: (intervalM: number | null) => mutation.mutateAsync({ intervalM }).then(() => undefined, () => undefined),
  };
}

/** The dialog's row: *Contour interval*. */
export function ContourIntervalRow({ labelClass }: { labelClass: string }) {
  const { t } = useTranslation("editor");
  const iv = useContourInterval();
  const d = iv.data;
  const [text, setText] = useState("");
  const shown = d ? String(d.confirmedM ?? d.assumedM) : "";
  // The prefill follows the stored value (a confirm, a change from another place).
  useEffect(() => { setText(shown); }, [shown]);
  if (!d || !iv.hasContours) return null;
  const parsed = parseInterval(text);
  const confirmed = d.confirmedM !== null;
  const changed = parsed !== null && parsed !== d.confirmedM;
  return (
    <div data-testid="editor-map-info-interval" data-assumed={d.assumedM} data-confirmed={confirmed ? String(d.confirmedM) : ""} data-from={d.from} className="space-y-1">
      <div className="flex items-center gap-3">
        <dt className={labelClass}>{t("mapInfoInterval")}</dt>
        <dd className="min-w-0 flex flex-wrap items-center gap-1.5">
          <input data-testid="editor-map-info-interval-input" list="editor-map-info-interval-list" inputMode="decimal" disabled={!iv.canEdit || iv.saving}
            value={text} onChange={(e) => setText(e.target.value)} aria-label={t("mapInfoInterval")}
            className="w-14 px-1 py-0.5 rounded border border-slate-200 bg-white text-xs font-mono disabled:bg-slate-50" />
          <datalist id="editor-map-info-interval-list">{INTERVAL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
          <span className="text-slate-500">m</span>
          <span data-testid="editor-map-info-interval-state" data-state={confirmed ? "confirmed" : "unconfirmed"}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${confirmed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
            {t(confirmed ? "intervalConfirmed" : "intervalNotConfirmed")}
          </span>
          {iv.canEdit && (
            <button type="button" data-testid="editor-map-info-interval-save" disabled={iv.saving || parsed === null || (confirmed && !changed)}
              onClick={() => { if (parsed !== null) void iv.save(parsed); }}
              className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer">
              {t(confirmed ? "intervalChange" : "intervalConfirm")}
            </button>
          )}
        </dd>
      </div>
      {text.trim() !== "" && parsed === null && <p data-testid="editor-map-info-interval-invalid" className="text-[11px] text-red-600">{t("intervalInvalid")}</p>}
      {d.from === "club" && <p data-testid="editor-map-info-interval-club" className="text-[11px] text-slate-500">{t("intervalFollowsClub")}</p>}
      {d.suspect && (
        <p data-testid="editor-map-info-interval-suspect" className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{t("intervalSuspect")}</p>
      )}
      {iv.error && <p className="text-[11px] text-red-600">{iv.error}</p>}
    </div>
  );
}

/** Asks once, while the map has contours and no confirmed interval; gone once confirmed (§0.43). */
export function IntervalBanner({ nameId }: { nameId: string | null }) {
  const { t } = useTranslation("editor");
  const iv = useContourInterval();
  const key = `oxygen:interval-banner-dismissed:${nameId ?? ""}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return window.sessionStorage.getItem(key) === "1"; } catch { return false; }
  });
  if (!iv.canEdit || !iv.hasContours || !iv.data || iv.data.confirmedM !== null || dismissed) return null;
  return (
    <div data-testid="editor-interval-banner" role="status"
      className="absolute left-1/2 top-1 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-900 shadow-sm">
      <span className="truncate">{t("intervalBanner")}</span>
      <button type="button" data-testid="editor-interval-banner-open" onClick={openMapInfoAtInterval}
        className="shrink-0 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[11px] hover:bg-amber-100 cursor-pointer">{t("intervalConfirm")}</button>
      <button type="button" data-testid="editor-interval-banner-dismiss" aria-label={t("intervalDismiss")}
        onClick={() => { setDismissed(true); try { window.sessionStorage.setItem(key, "1"); } catch { /* not remembered */ } }}
        className="shrink-0 text-amber-700 hover:text-amber-900 cursor-pointer">×</button>
    </div>
  );
}

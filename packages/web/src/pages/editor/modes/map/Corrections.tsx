/**
 * The inspector's *Corrections* list (docs/course-editor.md §13 "Inspector"; docs/map-patches.md §1.4, §2.3): every
 * op of the event's patch in op-id order — a click locates its object, *Revert* removes it — and the
 * *Apply corrections* toggle (`mapPatch.setEnabled`).
 *
 * Under it, the corrections the pin move could not carry over (§13 "Unresolved"; map-patches §4, row G11): the
 * patch's `unresolved` entries with *Attach* (onto the selected object) and *Drop*. The block reads the session's
 * patch and writes itself, delivering replies as Map mode's writes do, so `MapMode.tsx` is unchanged (user
 * 2026-11-15, G11 question 3: no undo entry, no locate, outside Map mode's write interlock — Pending).
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { mapDocument } from "@oxygen/shared";
import { trpc } from "../../../../lib/trpc";
import { getMapPatch, loadMapPatch, setMapPatch, subscribeMapPatch, type MapPatchDelivery } from "../../../../lib/map-document-cache";
import { refKey, sameRef, type CorrectionRow, type MapObjectRef } from "./model";

export function CorrectionsList({ rows, selected, enabled, canWrite, busy, onLocate, onRevert, onEnabled }: {
  rows: readonly CorrectionRow[];
  selected: MapObjectRef | null;
  enabled: boolean;
  /** `courses.edit`: revert and the toggle (they stay while the corrections are off). */
  canWrite: boolean;
  /** The toggle's write is in flight. */
  busy: boolean;
  onLocate: (row: CorrectionRow) => void;
  onRevert: (row: CorrectionRow) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="px-2.5 py-2 flex flex-col gap-1.5 text-xs">
      <label className="flex items-center gap-1.5" title={t("correctionsApplyHint")}>
        <input type="checkbox" data-testid="editor-corrections-apply" checked={enabled} disabled={!canWrite || busy}
          onChange={(e) => onEnabled(e.target.checked)} className="cursor-pointer disabled:cursor-not-allowed" />
        <span>{t("correctionsApply")}</span>
        <span data-testid="editor-corrections-count" data-count={rows.length} className="ml-auto text-slate-400">{rows.length}</span>
      </label>
      {rows.length === 0 ? (
        <p data-testid="editor-corrections-none" className="text-[11px] text-slate-500">{t("correctionsNone")}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.opId} data-testid="editor-correction-row" data-op-id={r.opId} data-op={r.op} data-ref={refKey(r.ref)} data-issue={r.issue ?? undefined}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${sameRef(r.ref, selected) ? "bg-purple-50" : "hover:bg-slate-50"}`}>
              <button type="button" data-testid="editor-correction-locate" onClick={() => onLocate(r)} disabled={r.label === null}
                className="flex-1 min-w-0 text-left truncate cursor-pointer disabled:cursor-default"
                title={r.issue ? t(`issue_${r.issue}`) : undefined}>
                <span className="text-slate-500">{t(`op_${r.op}`)}</span>{" "}
                <span className={r.label === null ? "text-slate-400 italic" : ""}>{r.label ?? t("correctionMissing")}</span>
                {r.issue && <span className="ml-1 text-amber-700">⚠</span>}
              </button>
              <button type="button" data-testid="editor-correction-revert" disabled={!canWrite} onClick={() => onRevert(r)}
                className={BUTTON}>
                {t("correctionRevert")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <UnresolvedCorrections selected={selected} canWrite={canWrite} correctionsOn={enabled} />
    </div>
  );
}

const BUTTON = "shrink-0 px-1.5 py-0.5 rounded text-[11px] text-slate-600 border border-slate-200 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

/** A refusal as the editor says it: the `PATCH_*` code's text, the offline text, else the message (as Map mode's). */
function patchErrorText(e: unknown, t: TFunction<"editor">): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = /^(PATCH_[A-Z_]+)/.exec(message)?.[1];
  const text = code ? t(`patchError_${code}`, { defaultValue: "" }) : "";
  if (text) return text;
  if (/connectivity/i.test(message)) return t("patchError_offline");
  return message;
}

/** The symbol an entry was on, as the row names it: the target's, else the op's `{ doc }` symbol, else the patch symbol key. */
function entryLabel(e: mapDocument.UnresolvedOp): string {
  const s = e.target?.symbol ?? e.symbol;
  if (s) return `${s.code} ${s.name}`.trim();
  return "symbol" in e.op && "patch" in e.op.symbol ? e.op.symbol.patch : "";
}

const NO_DELIVERY = (): MapPatchDelivery | undefined => undefined;

/** *Corrections* → *Not carried over* (§13 "Unresolved"): absent while the patch has none. */
function UnresolvedCorrections({ selected, canWrite, correctionsOn }: {
  selected: MapObjectRef | null;
  canWrite: boolean;
  /** *Apply corrections*: attach is a hide-like gesture, off while the corrections are (§13). */
  correctionsOn: boolean;
}) {
  const { t } = useTranslation("editor");
  const { nameId = "" } = useParams<{ nameId: string }>();
  const utils = trpc.useUtils();
  const subscribe = useCallback((fn: () => void) => (nameId ? subscribeMapPatch(nameId, fn) : () => undefined), [nameId]);
  const delivery = useSyncExternalStore(subscribe, nameId ? () => getMapPatch(nameId) : NO_DELIVERY);
  const patch = delivery?.patch ?? null;
  const attachM = trpc.mapPatch.attachUnresolved.useMutation();
  const applyM = trpc.mapPatch.applyChange.useMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = useCallback(async (key: string, send: () => Promise<MapPatchDelivery>) => {
    setBusy(key);
    setError(null);
    try {
      const res = await send();
      setMapPatch(nameId, res);
      utils.course.mapMetadata.setData(undefined, (old) => (old ? { ...old, patchVersion: res.version } : old));
    } catch (e) {
      setError(patchErrorText(e, t));
      void utils.course.mapMetadata.invalidate();
      void loadMapPatch(nameId);
    } finally {
      setBusy(null);
    }
  }, [nameId, utils, t]);

  const entries = patch?.unresolved ? Object.keys(patch.unresolved).sort().map((key) => [key, patch.unresolved![key]] as const) : [];
  if (!patch || entries.length === 0) return null;
  const documentHash = patch.documentHash;
  const source = selected && "source" in selected ? selected.source : null;
  return (
    <div data-testid="editor-corrections-unresolved" data-count={entries.length} className="mt-1 pt-1.5 border-t border-slate-100 flex flex-col gap-1">
      <div className="flex items-center gap-1.5" title={t("correctionsUnresolvedHint")}>
        <span className="font-medium text-amber-800">{t("correctionsUnresolved")}</span>
        <span className="ml-auto text-slate-400">{entries.length}</span>
      </div>
      <ul className="flex flex-col">
        {entries.map(([key, e]) => {
          const dropOnly = e.reason !== "target" || e.op.op === "add";
          const attachTitle = dropOnly ? t("correctionAttachSymbol") : source === null ? t("correctionAttachNeedsSelection") : t("correctionAttachHint");
          return (
            <li key={key} data-testid="editor-correction-unresolved" data-key={key} data-op={e.op.op} data-reason={e.reason}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-slate-50">
              <span className="flex-1 min-w-0 truncate" title={t("correctionsUnresolvedHint")}>
                <span className="text-slate-500">{t(`op_${e.op.op}`)}</span>{" "}
                <span>{entryLabel(e)}</span>{" "}
                <span className="text-amber-700">· {t(`unresolved_${e.reason}`)}</span>
              </span>
              <button type="button" data-testid="editor-correction-attach" title={attachTitle}
                disabled={!canWrite || !correctionsOn || dropOnly || source === null || busy !== null}
                onClick={() => source !== null && void write(key, () => attachM.mutateAsync({ documentHash, key, sourceIndex: source }))}
                className={BUTTON}>
                {t("correctionAttach")}
              </button>
              <button type="button" data-testid="editor-correction-drop" disabled={!canWrite || busy !== null}
                onClick={() => void write(key, () => applyM.mutateAsync({ documentHash, removeUnresolved: [key] }))}
                className={BUTTON}>
                {t("correctionDrop")}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p data-testid="editor-corrections-unresolved-error" className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
}

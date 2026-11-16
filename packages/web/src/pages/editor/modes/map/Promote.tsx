/**
 * *Save corrections to the club map* (docs/course-editor.md §13 "Promote"; docs/map-patches.md §5, row G12b): the
 * Map-mode section that turns the event's applicable corrections into the club map's next version
 * (`mapPatch.promote`, G12a). Offered when the pin is a club version; a confirm dialog with the label prefilled from
 * the event (answer 6: not an undo entry, so it asks first); while the job is queued or running Map mode is
 * read-only (answer 4) and shows its progress, followed through `mapPatch.promoteStatus`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../../../../lib/trpc";
import { loadMapPatch, setMapPatch } from "../../../../lib/map-document-cache";
import { defaultPromoteLabel, isPromoting, promoteErrorKey, promoteLabel, promoteOffer, type PromoteJob } from "./promote";
import { PromoteDialog } from "./PromoteDialog";

export interface PromoteArgs {
  enabled: boolean;
  nameId: string;
  canEdit: boolean;
  correctionsOn: boolean;
  /** The corrections that apply (rows without an issue). */
  applicable: number;
  /** A Map-mode write is in flight. */
  writing: boolean;
  /** A promote was accepted, or one is seen running: Map mode's undo entries go (answer 6). */
  onStarted: () => void;
}

export interface Promote {
  /** Map mode is read-only: a promote is being sent or its job is queued or running. */
  locked: boolean;
  /** The inspector's section; null when promote is not offered. */
  section: ReactNode;
  /** The progress line shown at the inspector's top while locked. */
  banner: ReactNode;
}

const POLL_MS = 2000;

export function usePromote(a: PromoteArgs): Promote {
  const { t } = useTranslation("editor");
  const utils = trpc.useUtils();
  const { enabled, nameId, onStarted } = a;
  const meta = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY, enabled });
  const clubMapVersionId = meta.data?.clubMapVersionId ?? null;
  const lease = trpc.lease.status.useQuery(undefined, { enabled: enabled && !!clubMapVersionId, staleTime: 60_000, refetchOnWindowFocus: false });
  const status = trpc.mapPatch.promoteStatus.useQuery(undefined, {
    enabled: enabled && !!clubMapVersionId,
    refetchInterval: (q) => (isPromoting(q.state.data) ? POLL_MS : false),
  });
  const promoteM = trpc.mapPatch.promote.useMutation();
  const job: PromoteJob | null = status.data ?? null;
  const sending = promoteM.isPending;
  const running = isPromoting(job);
  const locked = enabled && (sending || running);

  const [dialog, setDialog] = useState<{ label: string; touched: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Saved: the new version's number when the reply had it, else true. */
  const [done, setDone] = useState<number | true | null>(null);
  /** The job this session saw queued or running: its end (done, failed) is reported here. */
  const watching = useRef<string | null>(null);

  const startedRef = useRef(onStarted);
  startedRef.current = onStarted;
  // A promote seen running (another session's too) drops Map mode's undo entries once per job.
  const dropped = useRef<string | null>(null);
  useEffect(() => {
    if (!running || !job || dropped.current === job.id) return;
    dropped.current = job.id;
    watching.current = job.id;
    startedRef.current();
  }, [running, job]);
  // The job's end: the event's pin and patch moved (done) — reload both; a failure is said.
  useEffect(() => {
    if (!job || running || watching.current !== job.id) return;
    watching.current = null;
    void utils.course.mapMetadata.invalidate();
    void utils.clubMap.list.invalidate();
    void loadMapPatch(nameId);
    if (job.state === "failed") setError(t("promoteFailed", { error: job.error ?? "" }));
    else setDone(true);
  }, [job, running, utils, nameId, t]);

  const open = useCallback(() => {
    setError(null);
    setDone(null);
    const d = utils.competition.dashboard.getData();
    setDialog({ label: defaultPromoteLabel(d?.event?.name, d?.event?.date), touched: false });
    if (!d) {
      void utils.competition.dashboard.fetch().then((x) => {
        setDialog((cur) => (cur && !cur.touched ? { ...cur, label: defaultPromoteLabel(x?.event?.name, x?.event?.date) } : cur));
      }, () => undefined);
    }
  }, [utils]);
  const close = useCallback(() => setDialog(null), []);

  const confirm = useCallback(async () => {
    const label = dialog ? promoteLabel(dialog.label) : null;
    if (!label) return;
    setDialog(null);
    setError(null);
    try {
      const res = await promoteM.mutateAsync({ label });
      if (dropped.current !== res.job.id) {
        dropped.current = res.job.id;
        startedRef.current();
      }
      setMapPatch(nameId, { version: res.version, patch: res.patch });
      utils.mapPatch.promoteStatus.setData(undefined, res.job);
      if (isPromoting(res.job)) watching.current = res.job.id;
      else {
        // Ended inside the hold: said here, not again by the job-end effect (a refetch may have seen it running).
        watching.current = null;
        void utils.course.mapMetadata.invalidate();
        void utils.clubMap.list.invalidate();
        void loadMapPatch(nameId);
        if (res.job.state === "failed") setError(t("promoteFailed", { error: res.job.error ?? "" }));
        else setDone(res.clubMapVersion.seq);
      }
    } catch (e) {
      const key = promoteErrorKey(e);
      const message = e instanceof Error ? e.message : String(e);
      setError((key ? t(key, { defaultValue: "" }) : "") || message);
      void utils.mapPatch.promoteStatus.invalidate();
    }
  }, [dialog, promoteM, nameId, utils, t]);

  const offer = enabled ? promoteOffer({
    clubMapVersionId, canEdit: a.canEdit, nodeRole: lease.data?.nodeRole, job: sending ? { id: "", state: "running", stage: null, progress: 0, error: null } : job,
    correctionsOn: a.correctionsOn, applicable: a.applicable, writing: a.writing,
  }) : null;

  const banner = locked ? (
    <p data-testid="editor-map-promoting" data-state={sending && !running ? "sending" : job?.state} data-progress={job?.progress ?? 0}
      className="px-2.5 py-1.5 text-[11px] text-purple-800 bg-purple-50">
      {t("promoteRunning", { progress: Math.round((running ? job?.progress ?? 0 : 0) * 100) })}
    </p>
  ) : null;

  const section = offer ? (
    <div className="px-2.5 py-2 flex flex-col gap-1.5 text-xs">
      <p className="text-[11px] text-slate-500">{t("promoteHint")}</p>
      <button type="button" data-testid="editor-map-promote" data-block={offer.block ?? undefined} disabled={offer.block !== null} onClick={open}
        className="self-start px-2.5 py-1 rounded-md text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
        {t("promote")}
      </button>
      {offer.block && offer.block !== "busy" && (
        <p data-testid="editor-map-promote-reason" data-reason={offer.block} className="text-[11px] text-slate-500">{t(`promoteBlock_${offer.block}`)}</p>
      )}
      {done !== null && <p data-testid="editor-map-promote-done" className="text-[11px] text-emerald-700">{done === true ? t("promoteDoneLater") : t("promoteDone", { seq: done })}</p>}
      {error && <p data-testid="editor-map-promote-error" className="text-[11px] text-red-700">{error}</p>}
      {dialog && (
        <PromoteDialog label={dialog.label} count={a.applicable} onLabel={(label) => setDialog({ label, touched: true })} onCancel={close}
          onConfirm={() => void confirm()} />
      )}
    </div>
  ) : null;

  return { locked, section, banner };
}

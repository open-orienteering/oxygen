/**
 * What `MapPanel` shows for a map without a pinned document
 * (docs/map-rendering.md §5.4 "Selecting the layer"): the event's latest
 * import job, not a viewer — since E3 there are no tiles to fall back to.
 *
 * - `pending`: the job is queued or running ("being prepared", polled).
 * - `review`: the job is done but its document is not the event's pin yet
 *   (an import that waits for review): a link to the review page.
 * - `failed`: the job failed; its error.
 * - `unknown`: no job (a map from before the backfill), or the viewer may
 *   not read jobs (a kiosk): the backfill hint.
 *
 * When a job finishes with a document, `onDocumentReady` asks the panel
 * to re-read the map metadata; the panel then mounts the viewer.
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { isJobPending, jobProgressPercent } from "../lib/map-review";
import { mapImportView } from "../lib/map-import-view";

/** The fields of `mapImport.latestForEvent` this view reads. */
interface ImportJob {
  id: string;
  state: string;
  progress: number;
  documentHash: string | null;
  error: string | null;
}

export function MapImportState({
  className = "",
  style,
  onDocumentReady,
}: {
  className?: string;
  style?: CSSProperties;
  onDocumentReady: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const { nameId } = useParams<{ nameId: string }>();
  // Polled while the job is pending. A ref, not the query callback's
  // argument: the job's `report` JsonValue trips TS2589 when inferred
  // (as in MapReviewPage).
  const pendingRef = useRef(true);
  const latest = trpc.mapImport.latestForEvent.useQuery(undefined, {
    retry: false,
    refetchInterval: () => (pendingRef.current ? 2000 : false),
  });
  const job: ImportJob | null | undefined = latest.isError ? null : (latest.data as ImportJob | null | undefined);
  const view = mapImportView(job);
  const pending = job === undefined || (job !== null && isJobPending(job.state));
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // A job that finished with a document: the pin may already be there.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.state !== "done" || !job.documentHash) return;
    if (asked.current === job.id) return;
    asked.current = job.id;
    onDocumentReady();
  }, [job, onDocumentReady]);

  return (
    <div
      data-testid="map-import-state"
      data-state={view}
      className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`}
      style={style}
    >
      <div className="max-w-xs p-4 text-center text-sm text-slate-600">
        {view === "pending" && (
          <>
            <div className="w-6 h-6 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin mx-auto mb-2" />
            <p>{t("mapImportPending")}</p>
            {job && job.progress > 0 && <p className="mt-1 text-xs text-slate-400">{jobProgressPercent(job.progress)} %</p>}
          </>
        )}
        {view === "review" && job?.documentHash && (
          <>
            <p>{t("mapImportReview")}</p>
            {nameId && (
              <Link
                to={`/${nameId}/map-review/${job.documentHash}`}
                data-testid="map-import-review-link"
                className="mt-2 inline-block text-xs text-blue-600 hover:text-blue-800"
              >
                {t("mapImportReviewLink")}
              </Link>
            )}
          </>
        )}
        {view === "failed" && <p className="text-red-700">{t("mapImportFailed", { error: job?.error ?? "" })}</p>}
        {view === "unknown" && <p>{t("mapImportUnknown")}</p>}
      </div>
    </div>
  );
}

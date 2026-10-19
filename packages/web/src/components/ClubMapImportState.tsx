import { useTranslation } from "react-i18next";

export interface ClubMapImportJob {
  state: string;
  error: string | null;
}

/** True while a version-less library entry's import may still finish. */
export function isClubMapImportPending(job: ClubMapImportJob | null): boolean {
  return job?.state === "queued" || job?.state === "running";
}

/**
 * Import state of a club-library entry that has no version yet
 * (docs/map-storage.md §6.5): it can be neither downloaded nor copied
 * into an event until the import produces one.
 */
export function ClubMapImportState({
  job,
  className = "",
}: {
  job: ClubMapImportJob | null;
  className?: string;
}) {
  const { t } = useTranslation("library");
  const pending = isClubMapImportPending(job);
  const label = pending
    ? t("importing")
    : job?.error
      ? t("importFailed", { error: job.error })
      : t("importFailedUnknown");
  return (
    <div
      data-testid="library-map-import-state"
      data-state={pending ? "pending" : "failed"}
      className={`${pending ? "text-blue-600" : "text-amber-700"} ${className}`}
    >
      {label}
    </div>
  );
}

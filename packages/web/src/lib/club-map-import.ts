export interface ClubMapImportJob {
  state: string;
  error: string | null;
}

/** True while a version-less library entry's import may still finish. */
export function isClubMapImportPending(job: ClubMapImportJob | null): boolean {
  return job?.state === "queued" || job?.state === "running";
}

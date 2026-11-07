import { isJobPending } from "./map-review";

/**
 * What `MapImportState` shows for a map without a pinned document
 * (docs/map-rendering.md §5.4 "Selecting the layer"), from the event's
 * latest import job: `undefined` while it loads, `null` for none or
 * unreadable (a kiosk).
 */
export type MapImportView = "pending" | "review" | "failed" | "unknown";

export function mapImportView(job: { state: string; documentHash: string | null } | null | undefined): MapImportView {
  if (job === undefined) return "pending";
  if (job === null) return "unknown";
  if (isJobPending(job.state)) return "pending";
  if (job.state === "done" && job.documentHash) return "review";
  if (job.state === "failed") return "failed";
  return "unknown";
}

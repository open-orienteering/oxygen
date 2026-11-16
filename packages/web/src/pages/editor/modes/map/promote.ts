/**
 * *Save corrections to the club map* (docs/course-editor.md §13 "Promote"; docs/map-patches.md §5, rows G12a / G12b):
 * when it is offered, why it is disabled, the dialog's label, the job's state and a refusal's text key. Pure.
 */

/** A promote job as `mapPatch.promoteStatus` and `mapPatch.promote` answer it (map-patches §5.3). */
export interface PromoteJob {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  stage: string | null;
  progress: number;
  error: string | null;
}

/** `mapPatch.promote`'s label bound (`PROMOTE_LABEL_MAX` in the API). */
export const PROMOTE_LABEL_MAX = 200;

/** While it is queued or running Map mode is read-only (§5 answer 4). */
export const isPromoting = (job: PromoteJob | null | undefined): boolean => job?.state === "queued" || job?.state === "running";

/**
 * Why the button is disabled, in this order; null when it is enabled. `readonly`: no `courses.edit`; `venue`: a venue
 * box (the job and its status live in the cloud, so the box could not follow it); `running`: a promote is running;
 * `off`: *Apply corrections* is off (answer 5); `nothing`: no correction applies (answer 5); `busy`: a write in flight.
 */
export type PromoteBlock = "readonly" | "venue" | "running" | "off" | "nothing" | "busy";

export interface PromoteOfferInput {
  /** `course.mapMetadata.clubMapVersionId`: the pin is a club version (promote is for a club-pinned map, §5.3). */
  clubMapVersionId: string | null | undefined;
  canEdit: boolean;
  /** `lease.status.nodeRole`; undefined while it loads. */
  nodeRole: string | undefined;
  job: PromoteJob | null | undefined;
  correctionsOn: boolean;
  /** The ops that apply to the pinned document (*Corrections*' rows without an issue). */
  applicable: number;
  writing: boolean;
}

/** Null: not offered (the pin is not a club version); else the block, null when it can be pressed. */
export function promoteOffer(a: PromoteOfferInput): { block: PromoteBlock | null } | null {
  if (!a.clubMapVersionId) return null;
  const block: PromoteBlock | null = !a.canEdit ? "readonly"
    : a.nodeRole === "venue" ? "venue"
      : isPromoting(a.job) ? "running"
        : !a.correctionsOn ? "off"
          : a.applicable === 0 ? "nothing"
            : a.writing ? "busy"
              : null;
  return { block };
}

/** The dialog's prefilled label (§5 defaults): the event's name and date, cut to the procedure's bound. */
export function defaultPromoteLabel(name: string | null | undefined, date: string | null | undefined): string {
  return [name?.trim(), date?.trim().slice(0, 10)].filter(Boolean).join(" ").slice(0, PROMOTE_LABEL_MAX);
}

/** The label as sent: trimmed; null when empty (the confirm is disabled). */
export function promoteLabel(input: string): string | null {
  const s = input.trim().slice(0, PROMOTE_LABEL_MAX);
  return s.length > 0 ? s : null;
}

const CODES = ["PATCH_NOT_CLUB_MAP", "PATCH_NOT_LATEST", "PATCH_NOTHING_TO_PROMOTE", "PATCH_PROMOTING", "PATCH_NO_DOCUMENT", "PATCH_STALE"] as const;

/** A refusal's `editor.json` key (`promoteError_<CODE>`, `promoteError_UNAUTHORIZED`, `promoteError_offline`), else null. */
export function promoteErrorKey(e: unknown): string | null {
  const message = e instanceof Error ? e.message : String(e);
  const code = /^(PATCH_[A-Z_]+)/.exec(message)?.[1];
  if (code && (CODES as readonly string[]).includes(code)) return `promoteError_${code}`;
  const trpcCode = (e as { data?: { code?: string } } | null)?.data?.code;
  if (trpcCode === "UNAUTHORIZED") return "promoteError_UNAUTHORIZED";
  if (/connectivity/i.test(message)) return "promoteError_offline";
  return null;
}

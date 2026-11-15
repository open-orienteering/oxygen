/**
 * Promote (docs/map-patches.md §5; row G12a): an event's corrections saved
 * to the club map as a new version.
 *
 * `mapPatch.promote { label }` takes the ops of the event's patch that apply
 * to its pinned document (answer 5) as one layer, and inserts — in one
 * transaction under the patch row lock — the new `club_map_versions` row at
 * `seq + 1` (the base version's layers plus this one, the base's document
 * for now, `uploaded_by` the promoter) and its import job, which targets
 * both the event and the club map and bakes the layers at the store stage.
 * While that job is queued or running every `mapPatch` write is refused
 * with `PATCH_PROMOTING` (answer 4). When it finishes, `applyJobResult`
 * moves the version onto the baked document and `completePromote` the event
 * onto the version, removing the promoted ops from its patch; a failed job
 * deletes the pending version and leaves the patch whole.
 */

import { TRPCError } from "@trpc/server";
import { mapDocument } from "@oxygen/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { loadClubDecisions } from "./decisions.js";
import { decodedDocument, eventDocumentHash } from "./event-document.js";
import { DEFAULT_HOLD_MS, holdImportJob, insertQueuedImportJob, patchJson, type ImportJobRow } from "./jobs.js";
import { REKEY_TX, eventPatch, lockPatchRow, writePatch, type PatchDelivery } from "./patches.js";

/** The procedure's input bounds. */
export const PROMOTE_LABEL_MAX = 200;

export interface PromoteJobView {
  id: string;
  state: ImportJobRow["state"];
  stage: string | null;
  progress: number;
  error: string | null;
}

export interface PromoteResult extends PatchDelivery {
  /** The new version (its document follows when the job finishes). */
  clubMapVersion: { id: string; clubMapId: string; seq: number; label: string };
  job: PromoteJobView;
}

const refuse = (code: "PRECONDITION_FAILED" | "CONFLICT", message: string) => new TRPCError({ code, message });

const jobView = (j: Pick<ImportJobRow, "id" | "state" | "stage" | "progress" | "error">): PromoteJobView => ({
  id: j.id, state: j.state, stage: j.stage, progress: j.progress, error: j.error,
});

/**
 * Start a promote (§5). Refusals are `PRECONDITION_FAILED` message prefixes:
 * `PATCH_NO_DOCUMENT`, `PATCH_NOT_CLUB_MAP` (the pin is not a club
 * version's document), `PATCH_NOT_LATEST` (a newer version of the series
 * exists), `PATCH_NOTHING_TO_PROMOTE` (*Apply corrections* off, or no op
 * applies), `PATCH_PROMOTING`; a concurrent promote of another event onto
 * the same `seq` is `CONFLICT`. Returns after the hold (default 30 s), the
 * job possibly still running.
 */
export async function promoteEventPatch(db: PrismaClient, eventId: bigint, input: { label: string; userId: string | null; holdMs?: number }): Promise<PromoteResult> {
  const pin = await eventDocumentHash(db, eventId);
  if (!pin) throw refuse("PRECONDITION_FAILED", "PATCH_NO_DOCUMENT: the event has no map document");
  // Decoded outside the lock: a club-wide document takes a moment.
  const doc = await decodedDocument(db, pin);
  if (!doc) throw refuse("PRECONDITION_FAILED", "PATCH_NO_DOCUMENT: the event's map document cannot be read");

  const started = await writePatch(db, eventId, async (tx) => {
    const { patch } = await lockPatchRow(tx, eventId, pin);
    if (!patch.enabled) throw refuse("PRECONDITION_FAILED", "PATCH_NOTHING_TO_PROMOTE: Apply corrections is off");

    const file = await tx.mapFile.findFirst({
      where: { eventId, documentHash: pin },
      orderBy: { uploadedAt: "desc" },
      select: {
        sourceHash: true,
        document: { select: { patch: true, source: { select: { kind: true } } } },
        clubMapVersion: { select: { id: true, clubMapId: true, seq: true, sourceHash: true, documentHash: true, patch: true } },
      },
    });
    const base = file?.clubMapVersion;
    // The pin must be a document of the version the event took from the club library (§5; slice G split).
    if (!file || !base || base.sourceHash !== file.sourceHash || !mapDocument.sameVersionPatch(file.document?.patch, base.patch)) {
      throw refuse("PRECONDITION_FAILED", "PATCH_NOT_CLUB_MAP: the event's map is not a club map version");
    }
    const latest = await tx.clubMapVersion.aggregate({ where: { clubMapId: base.clubMapId }, _max: { seq: true } });
    const seq = latest._max.seq ?? base.seq;
    if (seq !== base.seq) throw refuse("PRECONDITION_FAILED", `PATCH_NOT_LATEST: the club map has a newer version (${seq}) than the event's (${base.seq})`);

    const promoted = mapDocument.versionLayerOfPatch(doc, patch);
    if (!promoted) throw refuse("PRECONDITION_FAILED", "PATCH_NOTHING_TO_PROMOTE: no correction applies to the map");
    const layers = [...mapDocument.parseVersionPatch(base.patch), promoted.layer];

    let version;
    try {
      version = await tx.clubMapVersion.create({
        data: {
          clubMapId: base.clubMapId,
          seq: seq + 1,
          label: input.label,
          sourceHash: base.sourceHash,
          // Moved onto the baked document by the job (map-storage §6.4).
          documentHash: base.documentHash,
          uploadedBy: input.userId,
          patch: patchJson(layers),
        },
        select: { id: true, clubMapId: true, seq: true, label: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw refuse("CONFLICT", "PATCH_NOT_LATEST: another version of the club map was saved meanwhile");
      }
      throw err;
    }
    const decisions = await loadClubDecisions(tx, file.document?.source.kind ?? "ocad");
    const job = await insertQueuedImportJob(tx, {
      sourceHash: base.sourceHash, eventId, clubMapId: base.clubMapId, startedBy: input.userId, decisions, patch: layers,
    });
    return { version, job };
  }, REKEY_TX);

  const job = await holdImportJob(db, started.job, input.holdMs ?? DEFAULT_HOLD_MS);
  return { ...(await eventPatch(db, eventId)), clubMapVersion: started.version, job: jobView(job) };
}

/** `mapPatch.promoteStatus`: the event's newest promote job, or null (G12b's progress and read-only state). */
export async function promoteStatus(db: PrismaClient, eventId: bigint): Promise<PromoteJobView | null> {
  const job = await db.mapImportJob.findFirst({
    where: { eventId, clubMapId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, state: true, stage: true, progress: true, error: true, patch: true },
  });
  if (!job || mapDocument.parseVersionPatch(job.patch).length === 0) return null;
  return jobView({ ...job, state: job.state as ImportJobRow["state"] });
}

/**
 * Import job status (docs/map-storage.md §6.3; research 07 §8). The poll
 * is the engine: asking for a job that is queued, or running with a
 * stale heartbeat, makes this instance pick it up. The review round —
 * `review` / `decide` / `finalise` and the CRT export / import of the
 * decisions (docs/map-import.md §2.2, research 06 §5.1) — lives here too.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, authedProcedure, adminProcedure, coursesViewProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import { resolveEventCapabilities } from "../permissions.js";
import { getImportJob, isClaimable, kickImportJobs, latestImportJobForEvent, type ImportJobRow } from "../map-store/jobs.js";
import { DecisionInputError, MAX_REVIEW_DECISIONS, reviewDecisionSchema } from "../map-store/decisions.js";
import { exportDocumentCrt, importDocumentCrt, MAX_CRT_BYTES } from "../map-store/crt.js";
import { buildReview, changeColourSettings, changeDeviation, decideOnDocument, finaliseDocument, type DeviationChangeResult, type ReviewTarget } from "../map-store/review.js";
import { DEVIATION_KEY } from "../map-store/colour-settings.js";
import { checkDocumentAccess, EDIT_ACCESS, READ_ACCESS, type DocumentAccessMode } from "../map-store/routes.js";
import type { Context } from "../trpc.js";
import type { PrismaClient } from "../generated/prisma/client.js";

const jobIdSchema = z.string().uuid();
const documentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "a 64-digit lower-case hex document hash");
/** A review round's target, as `finalise` takes it: the current event's map, or a club map series. */
const targetSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("event") }), z.object({ kind: z.literal("club"), clubMapId: z.string().uuid() })]);

/** The document route's predicate (docs/map-storage.md §4.2) for a tRPC caller; the event is `x-event-id`. */
async function requireDocument(ctx: Context, hash: string, mode: DocumentAccessMode): Promise<void> {
  const access = await checkDocumentAccess({ hash, authEnabled: ctx.authEnabled, user: ctx.user, kioskKey: mode.kiosk ? ctx.kioskKey : null, eventNameId: ctx.event?.nameId ?? null }, mode);
  if (!access.ok) throw new TRPCError({ code: access.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "No access to this map document" });
}

async function requireEventCapability(ctx: Context, cap: "courses.edit"): Promise<bigint> {
  if (!ctx.event) throw new TRPCError({ code: "BAD_REQUEST", message: "No event selected (missing or unresolved x-event-id header)" });
  if (ctx.authEnabled) {
    const db = prisma();
    const date = ctx.event.date ?? (await db.event.findUnique({ where: { id: ctx.event.id }, select: { date: true } }))?.date ?? new Date(0);
    const caps = await resolveEventCapabilities({ db, eventId: ctx.event.id, eventDate: date, user: ctx.user, authEnabled: true });
    if (!caps.has(cap)) throw new TRPCError({ code: "FORBIDDEN", message: `Missing capability ${cap}` });
  }
  return ctx.event.id;
}

async function present(db: PrismaClient, row: ImportJobRow) {
  const report = row.documentHash
    ? (await db.mapDocument.findUnique({ where: { hash: row.documentHash }, select: { report: true } }))?.report ?? null
    : null;
  return {
    id: row.id,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    sourceHash: row.sourceHash,
    documentHash: row.documentHash,
    error: row.error,
    eventId: row.eventId === null ? null : Number(row.eventId),
    clubMapId: row.clubMapId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    report,
  };
}

/** A colour change's target (`setColourOrder`, `setDeviation`): the event's needs `courses.edit`, a club map's a signed-in user. */
async function colourChangeTarget(ctx: Context, target: z.infer<typeof targetSchema>): Promise<ReviewTarget> {
  return target.kind === "event" ? { kind: "event", eventId: await requireEventCapability(ctx, "courses.edit") } : { kind: "club", clubMapId: target.clubMapId };
}

/** A failed colour change as the caller sees it. */
function colourChangeError(result: Extract<DeviationChangeResult, { ok: false }>, target: ReviewTarget): TRPCError {
  if (result.reason === "not-found") return new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
  if (result.reason === "no-target") return new TRPCError({ code: "NOT_FOUND", message: target.kind === "event" ? "The event has no map" : "Club map not found" });
  if (result.reason === "unknown-deviation") return new TRPCError({ code: "BAD_REQUEST", message: "The document has no such deviation" });
  return new TRPCError({ code: "PRECONDITION_FAILED", message: "The target's map is not this document's source file" });
}

function kickIfClaimable(db: PrismaClient, row: ImportJobRow): void {
  if (isClaimable(row)) void kickImportJobs(db);
}

export const mapImportRouter = router({
  /**
   * One job by id. Event jobs need `courses.view` on their event; club
   * jobs any signed-in user (the library is club-wide).
   */
  status: authedProcedure
    .input(z.object({ jobId: jobIdSchema }))
    .query(async ({ ctx, input }) => {
      const db = prisma();
      const row = await getImportJob(db, input.jobId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Import job not found" });
      if (row.eventId !== null && ctx.authEnabled) {
        const event = await db.event.findUnique({ where: { id: row.eventId }, select: { date: true } });
        const caps = await resolveEventCapabilities({
          db,
          eventId: row.eventId,
          eventDate: event?.date ?? new Date(0),
          user: ctx.user,
          authEnabled: true,
        });
        if (!caps.has("courses.view")) throw new TRPCError({ code: "FORBIDDEN", message: "No access to this event's map" });
      }
      kickIfClaimable(db, row);
      return present(db, row);
    }),

  /** The most recent job for the current event's map, or null. */
  latestForEvent: coursesViewProcedure.query(async ({ ctx }) => {
    const row = await latestImportJobForEvent(ctx.db, ctx.event.id);
    if (!row) return null;
    kickIfClaimable(ctx.db, row);
    return present(ctx.db, row);
  }),

  /**
   * The review payload for a stored document (06 §5.1): one row per source
   * symbol with its stored match, the matcher's top-3 candidates with
   * reasons and swatch URLs, colour class and flags; the colour stack; the
   * import report. Readable by whoever may fetch the document (§4.2) —
   * the predicate itself, so a kiosk key without a user is admitted as on
   * the route; anonymous callers without one get UNAUTHORIZED from it.
   * `clubMapId` (or else the current event) names the map the review is
   * for: its colour setting is in `colour.setting` and in `current`.
   */
  review: publicProcedure
    .input(z.object({ documentHash: documentHashSchema, clubMapId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireDocument(ctx, input.documentHash, READ_ACCESS);
      const target: ReviewTarget | null = input.clubMapId
        ? { kind: "club", clubMapId: input.clubMapId }
        : ctx.event ? { kind: "event", eventId: ctx.event.id } : null;
      const review = await buildReview(prisma(), input.documentHash, target);
      if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
      return review;
    }),

  /**
   * Record review decisions as club symbol decisions and import the
   * document's source again under them (06 §5.1, §5.3). The new document
   * is pinned nowhere until `finalise`; the job is returned as `status`
   * would, so a large map is polled like an upload.
   */
  decide: authedProcedure
    .input(z.object({ documentHash: documentHashSchema, decisions: z.array(reviewDecisionSchema).min(1).max(MAX_REVIEW_DECISIONS) }))
    .mutation(async ({ ctx, input }) => {
      await requireDocument(ctx, input.documentHash, EDIT_ACCESS);
      const db = prisma();
      let result;
      try {
        result = await decideOnDocument(db, { hash: input.documentHash, decisions: input.decisions, userId: ctx.user?.id ?? null });
      } catch (err: unknown) {
        if (err instanceof DecisionInputError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      if (!result.ok) throw new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
      return { applied: result.applied, job: await present(db, result.job) };
    }),

  /**
   * The map's colour order (docs/map-symbols.md §9.3 answer 1): `iof`, the
   * IOF colour layers, or `source`, the map's own table. Stored on the
   * target — the club map series (any signed-in user, as the library), or
   * the current event's map of the document's source (`courses.edit`) —
   * and read by every later import of it; the document's source is then
   * imported again in it, as `decide` does: the job is returned as
   * `status` would, and nothing is pinned until `finalise`.
   */
  setColourOrder: authedProcedure
    .input(z.object({ documentHash: documentHashSchema, order: z.enum(["iof", "source"]), target: targetSchema }))
    .mutation(async ({ ctx, input }) => {
      const target = await colourChangeTarget(ctx, input.target);
      await requireDocument(ctx, input.documentHash, EDIT_ACCESS);
      const db = prisma();
      const result = await changeColourSettings(db, { hash: input.documentHash, target, change: (s) => ({ ...s, order: input.order }), userId: ctx.user?.id ?? null });
      if (!result.ok) throw colourChangeError(result, target);
      return { settings: result.settings, job: await present(db, result.job) };
    }),

  /**
   * Override one deviation of the map, or reset it (docs/map-symbols.md
   * §9.3 "Overrides (row I7)", answer 2): `keep` or `drop` a deviation the
   * reviewed document lists, or `default` to remove the override. Stored
   * on the target as `setColourOrder` stores the order (only choices that
   * differ from the default), with its permission, and the document's
   * source imported again in the new setting: the job is returned as
   * `status` would, and nothing is pinned until `finalise`.
   */
  setDeviation: authedProcedure
    .input(z.object({ documentHash: documentHashSchema, key: z.string().max(200).regex(DEVIATION_KEY, "a deviation key upper>lower"), choice: z.enum(["keep", "drop", "default"]), target: targetSchema }))
    .mutation(async ({ ctx, input }) => {
      const target = await colourChangeTarget(ctx, input.target);
      await requireDocument(ctx, input.documentHash, EDIT_ACCESS);
      const db = prisma();
      const result = await changeDeviation(db, { hash: input.documentHash, target, key: input.key, choice: input.choice, userId: ctx.user?.id ?? null });
      if (!result.ok) throw colourChangeError(result, target);
      return { settings: result.settings, job: await present(db, result.job) };
    }),

  /**
   * The document's club decisions as an OpenOrienteering Mapper CRT
   * (docs/map-symbols.md §8.6); `includeMatches` adds its automatic
   * matches. Readable as `review` is: the rows are what review shows.
   */
  exportCrt: publicProcedure
    .input(z.object({ documentHash: documentHashSchema, includeMatches: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      await requireDocument(ctx, input.documentHash, READ_ACCESS);
      const out = await exportDocumentCrt(prisma(), input.documentHash, { includeMatches: input.includeMatches });
      if (!out) throw new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
      return out;
    }),

  /**
   * Record a CRT's rules as club symbol decisions through `decide`'s path
   * (docs/map-symbols.md §8.6): what applies is decided and re-imported in
   * one job without a target; every other line is reported. Nothing
   * applicable, or `dryRun`, writes nothing and returns `job: null`.
   */
  importCrt: authedProcedure
    .input(z.object({
      documentHash: documentHashSchema,
      crt: z.string().refine((s) => Buffer.byteLength(s, "utf8") <= MAX_CRT_BYTES, "a CRT of at most 1 MiB"),
      dryRun: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireDocument(ctx, input.documentHash, EDIT_ACCESS);
      const db = prisma();
      let result;
      try {
        result = await importDocumentCrt(db, { hash: input.documentHash, crt: input.crt, userId: ctx.user?.id ?? null, dryRun: input.dryRun });
      } catch (err: unknown) {
        if (err instanceof DecisionInputError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      if (!result.ok) throw new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
      return {
        decisions: result.decisions,
        unchanged: result.unchanged,
        skipped: result.skipped,
        warnings: result.warnings,
        applied: result.applied,
        job: result.job ? await present(db, result.job) : null,
      };
    }),

  /**
   * Pin a reviewed document where its source is the target's map: the
   * current event's `map_files` rows (`courses.edit`), or a club map's
   * version of that source (any signed-in user, as the club library).
   */
  finalise: authedProcedure
    .input(z.object({ documentHash: documentHashSchema, target: targetSchema }))
    .mutation(async ({ ctx, input }) => {
      const target = input.target.kind === "event"
        ? { kind: "event" as const, eventId: await requireEventCapability(ctx, "courses.edit") }
        : { kind: "club" as const, clubMapId: input.target.clubMapId };
      await requireDocument(ctx, input.documentHash, EDIT_ACCESS);
      const result = await finaliseDocument(prisma(), input.documentHash, target);
      if (!result.ok) {
        if (result.reason === "not-found") throw new TRPCError({ code: "NOT_FOUND", message: "Map document not found" });
        if (result.reason === "no-target") throw new TRPCError({ code: "NOT_FOUND", message: target.kind === "event" ? "The event has no map" : "Club map not found" });
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The target's map is not this document's source file" });
      }
      return { documentHash: input.documentHash, pinned: result.pinned, previous: result.previous };
    }),
});

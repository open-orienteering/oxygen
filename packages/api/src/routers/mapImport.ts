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
import { backfillStatus, planBackfill, startBackfill, type BackfillRun } from "../map-store/backfill.js";
import { DecisionInputError, MAX_REVIEW_DECISIONS, reviewDecisionSchema } from "../map-store/decisions.js";
import { exportDocumentCrt, importDocumentCrt, MAX_CRT_BYTES } from "../map-store/crt.js";
import { buildReview, decideOnDocument, finaliseDocument } from "../map-store/review.js";
import { checkDocumentAccess, EDIT_ACCESS, READ_ACCESS, type DocumentAccessMode } from "../map-store/routes.js";
import type { Context } from "../trpc.js";
import type { PrismaClient } from "../generated/prisma/client.js";

const jobIdSchema = z.string().uuid();
const documentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "a 64-digit lower-case hex document hash");

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

function kickIfClaimable(db: PrismaClient, row: ImportJobRow): void {
  if (isClaimable(row)) void kickImportJobs(db);
}

function presentRun(run: BackfillRun | null) {
  if (!run) return null;
  return {
    state: run.state,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    total: run.total,
    processed: run.processed,
    done: run.done,
    failed: run.failed,
    current: run.current,
    failures: run.failures.map((f) => ({ kind: f.kind, id: f.id, name: f.name, error: f.error })),
    error: run.error,
  };
}

async function presentBackfill() {
  const db = prisma();
  return { plan: await planBackfill(db), run: presentRun(backfillStatus()) };
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
   */
  review: publicProcedure
    .input(z.object({ documentHash: documentHashSchema }))
    .query(async ({ ctx, input }) => {
      await requireDocument(ctx, input.documentHash, READ_ACCESS);
      const review = await buildReview(prisma(), input.documentHash);
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
    .input(z.object({
      documentHash: documentHashSchema,
      target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("event") }), z.object({ kind: z.literal("club"), clubMapId: z.string().uuid() })]),
    }))
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

  /**
   * Backfill of pre-pipeline rows (docs/map-storage.md §6.7). `plan` is
   * what is still missing a document; `run` is this instance's current
   * or last run, null if none since start.
   */
  backfillStatus: adminProcedure.query(() => presentBackfill()),

  /** Start a backfill run in the background; one at a time per instance. */
  backfillStart: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(10_000).optional() }).optional())
    .mutation(async ({ input }) => {
      const started = startBackfill(prisma(), { limit: input?.limit });
      if (!started) throw new TRPCError({ code: "CONFLICT", message: "A map backfill is already running" });
      return presentBackfill();
    }),
});

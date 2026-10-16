/**
 * Import job status (docs/map-storage.md §6.3; research 07 §8). The poll
 * is the engine: asking for a job that is queued, or running with a
 * stale heartbeat, makes this instance pick it up.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure, adminProcedure, coursesViewProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import { resolveEventCapabilities } from "../permissions.js";
import { getImportJob, isClaimable, kickImportJobs, latestImportJobForEvent, type ImportJobRow } from "../map-store/jobs.js";
import { backfillStatus, planBackfill, startBackfill, type BackfillRun } from "../map-store/backfill.js";
import type { PrismaClient } from "../generated/prisma/client.js";

const jobIdSchema = z.string().uuid();

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

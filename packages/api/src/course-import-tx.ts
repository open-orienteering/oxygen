/**
 * The course import runs as one transaction (review package 17, decision
 * D3, course-layer.md §6.4): a failure anywhere — a crash after the
 * Replace-all wipe, a refused row, the journal append — leaves the event as
 * it was and journals nothing.
 *
 * `inImportTransaction` runs `prepare` first, outside any transaction (the
 * parse and the file's own refusals: a slow or refused file holds neither a
 * connection nor the lock), then the resolver with `ctx.db` swapped for the
 * transaction, so the import body keeps writing through `ctx.db`.
 */
import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";
import { lockEventLeaseAndSync } from "./event-locks.js";
import { mayWriteEventData, writeRefusalError } from "./sync/lease.js";

/** As the journal ingest's (events.ts INGEST_TX_OPTIONS): an import is hundreds of upserts. */
export const COURSE_IMPORT_TX = { timeout: 60_000, maxWait: 10_000 } as const;

export type InTransaction<C> = Omit<C, "db"> & { db: Prisma.TransactionClient };

export function inImportTransaction<C extends { db: PrismaClient; event: { id: bigint } }, I, P, R>(
  prepare: (ctx: C, input: I) => Promise<P>,
  resolver: (opts: { ctx: InTransaction<C>; input: I; prepared: P }) => Promise<R>,
): (opts: { ctx: C; input: I }) => Promise<R> {
  return async ({ ctx, input }) => {
    const prepared = await prepare(ctx, input);
    try {
      return await ctx.db.$transaction(async (tx) => {
        // Ordered against taking a lease (as the draw): a checkout cannot
        // snapshot the event halfway through an import, nor an import land
        // after the venue took the event (review package 17, M1).
        await lockEventLeaseAndSync(tx, ctx.event.id);
        const verdict = await mayWriteEventData(tx, ctx.event.id);
        if (!verdict.ok) throw writeRefusalError(verdict);
        // Two imports into one event (a double click, two operators) run one after the other.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`course-import:${ctx.event.id}`}))`;
        return resolver({ ctx: { ...ctx, db: tx }, input, prepared });
      }, COURSE_IMPORT_TX);
    } catch (error) {
      // P2028: the transaction ran past its timeout or waited too long to start.
      if (error instanceof PrismaNs.PrismaClientKnownRequestError && error.code === "P2028") {
        throw new TRPCError({
          code: "TIMEOUT",
          // Waiting for the event (an Eventor sync, another import, a busy pool) counts too.
          message: "The course import timed out and was undone; nothing was changed. The event may be busy (an Eventor sync or another import): try again in a minute.",
          cause: error,
        });
      }
      throw error;
    }
  };
}

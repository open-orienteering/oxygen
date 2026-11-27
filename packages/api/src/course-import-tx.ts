/**
 * The course import runs as one transaction (review package 17, decision
 * D3, course-layer.md §6.4): a failure anywhere — a crash after the
 * Replace-all wipe, a refused row, the journal append — leaves the event as
 * it was and journals nothing.
 *
 * `inImportTransaction` runs a tRPC resolver with `ctx.db` swapped for the
 * transaction, so the import body keeps writing through `ctx.db`.
 */
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

/** As the journal ingest's (events.ts INGEST_TX_OPTIONS): an import is hundreds of upserts. */
export const COURSE_IMPORT_TX = { timeout: 60_000, maxWait: 10_000 } as const;

export type InTransaction<C> = Omit<C, "db"> & { db: Prisma.TransactionClient };

export function inImportTransaction<C extends { db: PrismaClient; event: { id: bigint } }, I, R>(
  resolver: (opts: { ctx: InTransaction<C>; input: I }) => Promise<R>,
): (opts: { ctx: C; input: I }) => Promise<R> {
  return ({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      // Two imports into one event (a double click, two operators) run one after the other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`course-import:${ctx.event.id}`}))`;
      return resolver({ ctx: { ...ctx, db: tx }, input });
    }, COURSE_IMPORT_TX);
}

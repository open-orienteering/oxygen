/**
 * Free event slug lookup shared by `event.create` and `eventor.importEvent`
 * (review MC-13 / EVT-11).
 *
 * `events.name_id` is unique across live AND soft-deleted rows, so a name that
 * only a deleted event holds is taken too. The candidates are tried in order;
 * the first that no row holds is returned, null when all are taken.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export async function firstFreeEventSlug(
  db: Db,
  base: string,
  suffixes: readonly string[],
): Promise<string | null> {
  const candidates = [base, ...suffixes.map((s) => `${base}-${s}`)];
  for (const slug of candidates) {
    const row = await db.event.findUnique({ where: { nameId: slug }, select: { id: true } });
    if (!row) return slug;
  }
  return null;
}

/** The year of an ISO-ish date string, as a suffix candidate. */
export function yearOf(date: string): string | null {
  const m = /^(\d{4})/.exec(date);
  if (m) return m[1];
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : String(d.getUTCFullYear());
}

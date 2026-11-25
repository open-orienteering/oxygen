/**
 * The per-event lock that serialises the Eventor sync against taking a lease
 * (review: nothing ordered `eventor.sync` and `acquireLease`).
 *
 * A transaction-scoped advisory lock (released at commit or rollback, so no
 * connection ever keeps it). The sync takes it first in its transaction and
 * re-checks the lease; `acquireLease` takes it before inserting. Whichever
 * comes second sees the other's committed result.
 */

import type { Prisma } from "./generated/prisma/client.js";

export async function lockEventLeaseAndSync(
  tx: Prisma.TransactionClient,
  eventId: bigint,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`event-lease-sync:${eventId}`}))`;
}

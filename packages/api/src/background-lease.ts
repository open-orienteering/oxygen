/**
 * The lease rule for background jobs (docs/course-elevation.md §0.44,
 * review D8): a node that does not hold an event's lease does not search
 * its leg routes and does not clear or compute its climbs. It does
 * nothing and does not throw; the holder does the work.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { mayWriteEventData } from "./sync/lease.js";

const told = new Set<string>();

/** Whether this node may run `job` for the event; when not, says so once per event and reason. */
export async function mayRunBackgroundJob(db: PrismaClient | Prisma.TransactionClient, eventId: bigint, job: string): Promise<boolean> {
  const verdict = await mayWriteEventData(db, eventId);
  if (verdict.ok) return true;
  const key = `${job}/${eventId}/${verdict.reason}`;
  if (!told.has(key)) {
    told.add(key);
    console.info(`[${job}] event ${eventId}: not run on this node (${verdict.reason}${verdict.holder ? ` "${verdict.holder}"` : ""}); the holder does it.`);
  }
  return false;
}

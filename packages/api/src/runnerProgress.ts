/**
 * Progress flags shared by the start list and the result list (CRS-042):
 * the Results and Start list pages filter on them ("in forest", "not
 * started"), so both endpoints must compute them the same way.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { hasStartedByClock } from "./timeConvert.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Card numbers with at least one live free punch (radio, manual, online) in the event. */
export async function loadPunchedCardNos(db: Db, eventId: bigint): Promise<Set<number>> {
  const rows = await db.punch.groupBy({
    by: ["cardNo"],
    where: { eventId, removed: false },
  });
  return new Set(rows.map((p) => p.cardNo));
}

/** `hasPunches` / `hasStarted`, left out (undefined) when false. */
export function progressFlags(
  runner: { cardNo: number | null; startTime: number },
  punchSet: ReadonlySet<number>,
  zeroTime: number,
  nowDs: number,
): { hasPunches?: true; hasStarted?: true } {
  const out: { hasPunches?: true; hasStarted?: true } = {};
  if (runner.cardNo != null && punchSet.has(runner.cardNo)) out.hasPunches = true;
  if (hasStartedByClock(runner.startTime, zeroTime, nowDs)) out.hasStarted = true;
  return out;
}

/**
 * Which card row holds a runner's punches (API-11).
 *
 * `runner.cardId` is a cache of "the card row read for this runner". It is
 * only trusted while it still names the runner's current card number: a card
 * number changed at the desk (edit, link, Eventor sync, journal replay) makes
 * the old link stale, and the readout or the Eventor export must then use the
 * card row for the new number, never the previous card's punches. Writers
 * clear the link when they change `cardNo` (`buildRunnerUpdateData`, the
 * unlink path); this read rule covers rows written before that, and any
 * writer that misses it.
 */

export interface CardRowLike {
  id: string;
  cardNo: number;
  removed: boolean;
  updatedAt: Date;
}

/**
 * Pick the runner's card among already-loaded card rows: the linked row when
 * it is live and has the runner's card number, else the most recently updated
 * live row with that number, else null.
 */
export function pickRunnerCard<C extends CardRowLike>(
  runner: { cardId: string | null; cardNo: number | null },
  linked: C | null | undefined,
  byNumber: readonly C[],
): C | null {
  if (runner.cardNo == null || runner.cardNo <= 0) return null;
  if (linked && !linked.removed && linked.cardNo === runner.cardNo) return linked;
  let best: C | null = null;
  for (const c of byNumber) {
    if (c.removed || c.cardNo !== runner.cardNo) continue;
    if (!best || c.updatedAt > best.updatedAt) best = c;
  }
  return best;
}

type CardLookupDb = {
  card: {
    findFirst(args: {
      where: { eventId: bigint; cardNo: number; removed: false };
      orderBy: { updatedAt: "desc" };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

/** The id of the newest live card row read for `cardNo` in the event, or null: what a runner's `cardId` is set to when its card number is written. */
export async function liveCardId(db: CardLookupDb, eventId: bigint, cardNo: number): Promise<string | null> {
  const card = await db.card.findFirst({
    where: { eventId, cardNo, removed: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return card?.id ?? null;
}

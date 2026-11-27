/**
 * When the kiosk's readout screen prints a finish receipt by itself
 * (WEB-02). The three per-card queries are keyed by card number, so a
 * card read again (another day, a re-read) first answers from the cache:
 * the runner id there may belong to someone else now. Printing waits for
 * answers fetched after the screen opened, and happens once per screen.
 */
export function shouldAutoPrint({
  alreadyPrinted,
  runner,
  receipt,
  runnerFresh,
  receiptFresh,
}: {
  alreadyPrinted: boolean;
  runner: { id: number; finishTime: number } | null | undefined;
  receipt: { timing: { finishTime: number } } | null | undefined;
  /** `runner.findByCard` answered successfully since the screen opened (`isFreshSince`). */
  runnerFresh: boolean;
  /** `race.finishReceipt` answered successfully since the screen opened. */
  receiptFresh: boolean;
}): boolean {
  if (alreadyPrinted) return false;
  if (!runner || !receipt) return false;
  if (!runnerFresh || !receiptFresh) return false;
  // Only for runners with a finish time: the DB-stored one, or the
  // receipt's card-computed one (there as soon as storeReadout ran, before
  // applyResult wrote oRunner.FinishTime).
  return runner.finishTime > 0 || receipt.timing.finishTime > 0;
}

/**
 * A query's data was fetched successfully at or after `since`. Not
 * `isFetchedAfterMount`: that is also true after a refetch that failed,
 * when the data is still the cached row.
 */
export function isFreshSince(
  q: { isSuccess: boolean; isFetching: boolean; dataUpdatedAt: number },
  since: number,
): boolean {
  return q.isSuccess && !q.isFetching && q.dataUpdatedAt >= since;
}

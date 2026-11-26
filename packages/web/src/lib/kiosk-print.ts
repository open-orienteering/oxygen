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
  /** `isFetchedAfterMount` of `runner.findByCard`. */
  runnerFresh: boolean;
  /** `isFetchedAfterMount` of `race.finishReceipt`. */
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

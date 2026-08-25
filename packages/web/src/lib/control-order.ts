/**
 * Control ordering for lists and pickers.
 *
 * `control.list` returns rows in `seq` order — the order controls were
 * imported or created in, which is arbitrary from the operator's point of
 * view. The public control id is the primary punch code, so ordering by it
 * gives the control-number order an operator scans for.
 */

/** Compare two controls by punch code, ascending. */
export function compareByControlNumber(
  a: { id: number },
  b: { id: number },
): number {
  return a.id - b.id;
}

/** Copy of `controls` ordered by punch code, ascending. */
export function sortByControlNumber<T extends { id: number }>(
  controls: readonly T[],
): T[] {
  return [...controls].sort(compareByControlNumber);
}

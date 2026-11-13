/**
 * What Layout mode's sheet sections share (`SheetActions`, `SetterSection`):
 * the page's write wrappers and the reload after a sheet or template write.
 */

import { trpc } from "../../../lib/trpc";

export type Run = <T>(op: () => Promise<T>) => Promise<T | undefined>;
export type Record_ = (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;

/**
 * Reload what a sheet or template write changes. `leaving`: the shown row is
 * gone — the reads are only marked stale (the next target's read fetches
 * itself), so the deleted one is not read again before the view moves.
 */
export function useRefresh() {
  const utils = trpc.useUtils();
  return async (leaving = false) => {
    await Promise.all([
      utils.courseMap.list.invalidate(),
      utils.courseMap.resolveSheet.invalidate(undefined, leaving ? { refetchType: "none" } : undefined),
      utils.mapTemplate.list.invalidate(),
      utils.layout.classOverrides.invalidate(),
    ]);
  };
}

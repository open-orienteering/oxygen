/**
 * Pure routing helpers for the standalone kiosk mode.
 *
 * Keeping this logic outside of KioskPage.tsx makes it trivially unit-testable
 * and prevents the ref-based deduplication guard from drifting back into
 * "fires on unresolved entry / never resets after idle" territory.
 */

export interface StandaloneCardState {
  id: string;
  action: string;
  actionResolved: boolean;
}

/**
 * Determines whether the standalone kiosk should process a card update.
 *
 * Rules:
 * - Unresolved entries (actionResolved: false) are always skipped — DeviceManager
 *   emits them before the DB lookup completes; the resolved update follows shortly.
 * - The first resolved card after a reset (lastProcessed == null) is always processed.
 * - A card with the same {id, action} as the last processed card is skipped to
 *   prevent double-firing on React re-renders.
 * - A card with the same id but a *different* action (e.g. register → readout after
 *   registration) IS processed — the action change is meaningful.
 */
export function shouldProcessStandaloneCard(
  card: StandaloneCardState | null | undefined,
  lastProcessed: { id: string; action: string } | null,
): boolean {
  if (!card || !card.actionResolved) return false;
  if (!lastProcessed) return true;
  return !(lastProcessed.id === card.id && lastProcessed.action === card.action);
}

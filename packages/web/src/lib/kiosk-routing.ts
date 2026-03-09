/**
 * Pure function to determine which kiosk screen to show
 * based on the scanned card's action and the DB state of the runner.
 */

import type { CardAction } from "../context/DeviceManager";

export type KioskMode =
  | "registration-waiting"
  | "pre-start"
  | "readout";

export interface CardInfo {
  action: CardAction;
  hasRaceData: boolean;
  cardNumber: number;
}

export interface DbRunnerInfo {
  finishTime: number;
  status: number;
}

/**
 * Determine which kiosk screen to show for a scanned card.
 *
 * Decision tree:
 * - If card action is "register" but DB has a runner → use DB state instead
 * - If runner has finishTime > 0 or card has race data → readout
 * - If runner exists but no finish → pre-start
 * - If no runner found → registration-waiting
 */
export function determineKioskScreen(
  card: CardInfo,
  dbRunner: DbRunnerInfo | null,
): KioskMode {
  // Unknown card → registration
  if (!dbRunner) {
    if (card.action === "register") return "registration-waiting";
    // Shouldn't happen (pre-start/readout implies known runner), but fallback
    return "registration-waiting";
  }

  // Known runner with finish time → readout (reprint)
  if (dbRunner.finishTime > 0) return "readout";

  // Known runner, card has race data (punches) → readout (needs finish recording)
  if (card.hasRaceData) return "readout";

  // Known runner, no result yet → pre-start
  return "pre-start";
}

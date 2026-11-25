/**
 * With several readers, a read failure only concerns the card the kiosk is
 * showing when it comes from the reader that reported that card. A failure
 * from another reader still reaches the operator banner, but must not reset
 * the current detection or turn the kiosk's "reading" screen into an error.
 */
export function failureConcernsCurrentDetection(
  failureReaderId: string | undefined,
  detectionReaderId: string | null | undefined,
): boolean {
  return !(failureReaderId && detectionReaderId && failureReaderId !== detectionReaderId);
}

/**
 * Whether the standalone kiosk should turn its screen into "card not read" for
 * a read failure. DeviceManager publishes every failure (the operator banner
 * needs them all) and React batches events of one tick, so the kiosk must not
 * trust its own screen: it compares the failed card with the card the reader
 * reports as detected right now.
 *
 * - the failure must come from the reader of the current detection
 *   (`concernsCurrentDetection`), and
 * - no other card may be detected now (`detectedCardNo` is null once the
 *   failure cleared the detection, or equals the failed card).
 * - only a reading or idle screen is replaced; a result screen stays.
 */
export function shouldShowStandaloneReadFailure(
  failure: { cardNumber: number; concernsCurrentDetection: boolean },
  detectedCardNo: number | null,
  screenMode: string,
): boolean {
  if (!failure.concernsCurrentDetection) return false;
  if (detectedCardNo != null && detectedCardNo !== failure.cardNumber) return false;
  return screenMode === "reading" || screenMode === "idle";
}

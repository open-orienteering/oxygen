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

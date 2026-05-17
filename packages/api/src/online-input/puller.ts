/**
 * Online-input puller — stub. Long-running interval that polls ROC /
 * SICenter and inserts new punches. Being re-ported against the new schema.
 */

export function onlineInputPuller(): {
  start(): void;
  stop(): void;
} {
  return { start() {}, stop() {} };
}

export async function reconcileEnabledPullers(): Promise<void> {
  // No-op until re-port.
}

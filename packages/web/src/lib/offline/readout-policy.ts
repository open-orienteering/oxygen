/**
 * Pure decisions of the card-readout path, kept out of the React provider so
 * they can be unit-tested (docs/system/registration-and-readout.md §2a, §2b).
 */
import type { SICardReadout } from "../si-protocol";

/** How a readout got (or did not get) . */
export type SaveState =
  /** Stored on the server. */
  | ""
  /** Server unreachable:  in this device's outbox, drains later. */
  | ""
  /** Neither stored nor  (storage failure). The card must be read again. */
  | ""
  /** No event could be determined from the URL, so there was nowhere to queue it. */
  | "no-competition"
  /** The store or queue write is still in flight (a re-insert meanwhile is a duplicate). */
  | "saving";

export interface DedupCandidate {
  readout?: SICardReadout;
  competitionId?: string | null;
  persisted?: boolean;
  saveState?: SaveState;
}

/** Two readouts of the same card with identical punch data. */
export function readoutsMatch(a: SICardReadout, b: SICardReadout): boolean {
  if (a.cardNumber !== b.cardNumber) return false;
  if (a.startTime !== b.startTime) return false;
  if (a.finishTime !== b.finishTime) return false;
  if (a.checkTime !== b.checkTime) return false;
  if (a.punches.length !== b.punches.length) return false;
  for (let i = 0; i < a.punches.length; i++) {
    if (a.punches[i].controlCode !== b.punches[i].controlCode) return false;
    if (a.punches[i].time !== b.punches[i].time) return false;
  }
  return true;
}

/**
 * A re-read is a duplicate only when the earlier one is the same card data in
 * the SAME event and was actually stored or . A read that never reached
 * the server or the outbox is retried on the next insert (MC-05 / SI-16 / SYNC-03).
 */
export function findDuplicate<T extends DedupCandidate>(
  recent: readonly T[],
  readout: SICardReadout,
  competitionId: string | null,
): T | undefined {
  return recent.find(
    (c) =>
      c.readout !== undefined &&
      (c.persisted === true || c.saveState === "saving") &&
      (c.competitionId ?? null) === competitionId &&
      readoutsMatch(c.readout, readout),
  );
}

/**
 * Whether this device may queue `result.applied`. The server applies it with
 * operator rights, so a kiosk-key-only device (auth on, nobody signed in)
 * queues only its own `card.read` — decision D11, display-only otherwise.
 */
export function canApplyResults(authEnabled: boolean, signedIn: boolean): boolean {
  return !authEnabled || signedIn;
}

/** Reject a promise that takes longer than `ms` (SI-29: a black-holed network hangs for minutes). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

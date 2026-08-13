import type { SICardReadout } from "../si-protocol";
import type { CardReadPayload } from "./db";

/**
 * Build the offline `card.read` outbox payload from a WebSerial readout.
 *
 * SI hardware speaks **seconds since midnight**; the API contract (and the
 * `storeReadout` mutation the queue drains into) is **absolute deciseconds**.
 * The conversion must happen here, exactly like the online path multiplies by
 * 10 before calling `storeReadout` — a payload queued in raw seconds would be
 * applied 10x off once connectivity returns.
 */
export function toOfflineCardReadPayload(
  readout: SICardReadout,
  punchesFresh: boolean,
): CardReadPayload {
  const toDeciseconds = (t: number | null | undefined): number | undefined =>
    t !== null && t !== undefined ? t * 10 : undefined;

  return {
    cardNo: readout.cardNumber,
    punches: readout.punches.map((p) => ({
      controlCode: p.controlCode,
      time: p.time * 10,
    })),
    checkTime: toDeciseconds(readout.checkTime),
    startTime: toDeciseconds(readout.startTime),
    finishTime: toDeciseconds(readout.finishTime),
    cardType: readout.cardType,
    punchesFresh,
    batteryVoltage: readout.batteryVoltage ?? undefined,
    ownerData: readout.ownerData
      ? {
          firstName: readout.ownerData.firstName,
          lastName: readout.ownerData.lastName,
          sex: readout.ownerData.sex,
          dateOfBirth: readout.ownerData.dateOfBirth,
          club: readout.ownerData.club,
          phone: readout.ownerData.phone,
          email: readout.ownerData.email,
          country: readout.ownerData.country,
        }
      : undefined,
  };
}

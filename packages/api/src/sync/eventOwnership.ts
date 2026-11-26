/**
 * Who owns each column of the event row while the event is checked out to a
 * venue box (review MC-08; docs/system/offline-architecture.md "The event row
 * during a lease").
 *
 * - Identity and lifecycle columns are never copied between nodes.
 * - Venue-owned columns are what the arena changes on the day (kiosk key,
 *   rental-card fee, desk payment and receipt texts, AIR+ station config, the
 *   Google Sheets readout backup, zero time, date, time zone). During a lease
 *   their mutations are race procedures, so the cloud refuses them; the box's
 *   settings refresh leaves them alone, and the box pushes them back to the
 *   cloud on the settings cadence and at checkin (`pushVenueOwnedSettings`).
 * - Every other column is cloud-owned: its mutation is forwarded to the cloud
 *   (`CLOUD_OWNED_MUTATIONS`) and the box copies it with the settings refresh.
 */

/** Never copied from or to a peer: row identity and lifecycle state. */
export const EVENT_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "nameId",
  "removed",
  "createdAt",
  "updatedAt",
]);

/**
 * Results-closure columns the holder owns: kept out of the refresh but not
 * pushed back either, since the cloud cannot change them during a lease and
 * a zero-time move after checkout is refused on both nodes.
 */
export const VENUE_RESULTS_CLOSURE_FIELDS: ReadonlySet<string> = new Set(["zeroTime", "date"]);

/** Venue-owned settings the box pushes back to the cloud. */
export const VENUE_PUSHED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  // event.regenerateKioskKey
  "kioskKey",
  // event.setCardFee
  "cardFeeCents",
  // control.setAirPlusConfig
  "airPlus",
  "awakeHours",
  // event.setRegistrationConfig
  "paymentMethods",
  "swishNumber",
  "swishPayeeName",
  "printRegistrationReceipt",
  "registrationReceiptMessage",
  "finishReceiptMessage",
  "receiptFriskvardNote",
  "organizerEventorId",
  "orgNumber",
  "vatExempt",
  // event.setGoogleSheetsConfig
  "googleSheetsWebhookUrl",
  // event.setTimeSettings (the zero time is a results-closure field)
  "timeZone",
]);

/** Every column the settings refresh must not overwrite on the holder. */
export const VENUE_OWNED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  ...VENUE_RESULTS_CLOSURE_FIELDS,
  ...VENUE_PUSHED_EVENT_FIELDS,
]);

/**
 * Every mutation outside `sync/` that writes the event row, with how it
 * behaves during a lease. `venue`: a race procedure (or a lease check inside
 * the handler) that writes only venue-owned columns. `cloud`: listed in
 * `CLOUD_OWNED_MUTATIONS`. The coverage test (`event-settings-ownership.test.ts`) fails when a
 * new `event.update` writer is not listed here.
 */
export const EVENT_ROW_WRITERS: Readonly<Record<string, "venue" | "cloud">> = {
  "event.setTimeSettings": "venue",
  "event.setRegistrationConfig": "venue",
  "event.setGoogleSheetsConfig": "venue",
  "event.setCardFee": "venue",
  "event.regenerateKioskKey": "venue",
  "control.setAirPlusConfig": "venue",
  "event.updateType": "cloud",
  "course.setOverprintCuts": "cloud",
};

/** `row` reduced to the venue-owned columns the box pushes back. */
export function pickVenuePushedFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([k, v]) => VENUE_PUSHED_EVENT_FIELDS.has(k) && v !== undefined),
  );
}

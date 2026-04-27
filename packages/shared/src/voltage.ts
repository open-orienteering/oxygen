/**
 * Battery-voltage encoding for MeOS-compatible storage.
 *
 * MeOS stores SIAC battery voltage in `oCard.Voltage` as integer **millivolts**
 * (e.g. 2980 = 2.98 V). Oxygen previously wrote raw SIAC ADC bytes to the same
 * column, which is incompatible with MeOS and produced absurd readings (~270 V)
 * when the listing decoder tried to apply the SIAC raw-byte formula
 * `V = 1.9 + raw × 0.09` to a millivolt value.
 *
 * Going forward, every Oxygen-managed voltage column stores millivolts.
 * The helpers below are the only encode/decode path; data still in legacy
 * encodings is upgraded by a one-shot migration in `db.ts`.
 */

/** Storage encoding used by MeOS in `oCard.Voltage` and our readout history table. */
export const VOLTAGE_UNIT_PER_VOLT = 1000;

/**
 * Convert an integer millivolt value (as stored in MeOS / our DB) to volts.
 * Returns `null` for `0` and any negative input — those mean "not measured".
 */
export function voltsFromMeos(raw: number | bigint | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / VOLTAGE_UNIT_PER_VOLT;
}

/**
 * Encode volts (e.g. 2.98) for storage in MeOS-compatible columns. Returns
 * `null` when there's nothing to store — callers should omit the column from
 * their UPDATE rather than writing `0`.
 */
export function meosFromVolts(volts: number | null | undefined): number | null {
  if (volts == null || !Number.isFinite(volts) || volts <= 0) return null;
  return Math.round(volts * VOLTAGE_UNIT_PER_VOLT);
}

/**
 * One-shot decoder for legacy `oCard.Voltage` rows that contain a raw SIAC
 * ADC byte (Oxygen versions before the millivolt switch wrote 11/12/13 here).
 * The migration in `db.ts` calls this to upgrade rows where 0 < value < 256.
 *
 * Returns the equivalent millivolt value. Numbers ≥ 256 are already
 * millivolts and are returned unchanged.
 */
export function legacyRawByteToMillivolts(raw: number): number {
  if (raw <= 0 || raw >= 256) return raw;
  // SIAC raw-byte formula: V = 1.9 + raw × 0.09 → mV = 1900 + raw × 90.
  return 1900 + raw * 90;
}

/**
 * One-shot decoder for legacy `oxygen_card_readouts.Voltage` rows that
 * stored hundredths of a volt (e.g. 298 = 2.98 V). Real battery readings
 * always exceed 1.0 V, so anything < 1000 is treated as legacy hundredths.
 */
export function legacyHundredthsToMillivolts(raw: number): number {
  if (raw <= 0 || raw >= 1000) return raw;
  return raw * 10;
}

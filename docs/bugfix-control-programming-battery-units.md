# Programmed controls never reached the Controls list

## Symptom

An operator programmed a full set of field controls, but the Controls
page kept showing empty Battery / Checked / Type columns and no physical
units under any control. The programming panel reported every station as
`Programmed` with a plausible voltage, so nothing looked wrong.

In the affected event, `oxygen.control_units` had zero rows even though
controls had been programmed the day before.

## Root cause

A volts-versus-millivolts mismatch across the tRPC boundary.

- SI stations report battery voltage in volts: `parseStationInfo`
  computes `(raw * 5) / 65536`, a float such as `3.2137`.
- `control.recordProgramming` stores
  `control_units.battery_voltage_mv` and validated the input as
  `z.number().int()` — millivolts.

`ControlsPage` passed the station reading straight through, so Zod
rejected `3.2137` and the mutation failed with `BAD_REQUEST`. Because
the mutation had an `onSuccess` handler but no `onError`, the failure was
swallowed: the station really had been programmed, the results row said
so, and only the persisted record was missing. Every field of the
programming record was lost, not just the voltage.

## Fix

- `packages/web/src/lib/control-programming-payload.ts` owns the
  conversion, mirroring how `toOfflineCardReadPayload` owns the
  seconds → deciseconds conversion for card readouts. It emits integer
  millivolts, derives `batteryLow` from the 2.5 V service threshold, and
  omits the voltage entirely when the station reported no usable reading.
- `recordProgramming` accepts an explicit `batteryVoltageMv` alongside
  the legacy `batteryVoltage` name (the same alias pattern the procedure
  already uses for `programmedCode` / `lastProgrammedCode`), and both go
  through a 500–10,000 mV plausibility range. A reading passed through in
  volts now fails loudly instead of persisting as a few millivolts and
  marking the unit permanently flat.
- The programming panel surfaces a record failure, so a station that was
  programmed but not saved can no longer look like a success.

## Recovery

Records lost to this bug cannot be reconstructed — nothing was written.
Re-programming each station repopulates its `control_units` row.

## Regression coverage

- `packages/web/src/lib/__tests__/control-programming-payload.test.ts` —
  volts → integer millivolts, the low-battery threshold, the missing
  reading case, and the station identity fields the list renders.
- `packages/api/src/__tests__/integration/control.test.ts` — the
  explicit `batteryVoltageMv` field persists, and a volts-shaped value
  (`3.21`, and the rounded `3`) is rejected.

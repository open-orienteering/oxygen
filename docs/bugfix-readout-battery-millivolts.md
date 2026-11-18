# Bugfix: SIAC readouts with a battery value rejected by `storeReadout`

## Symptom

A SIAC card read out live (USB station, and every Reader BT SIAC readout)
never reached the server: the browser logged
`[DeviceManager] Failed to store readout on server — queuing offline event`
and the API answered `BAD_REQUEST` with
`batteryVoltage: Invalid input: expected int, received number`.
The readout was then only queued as an offline `card.read` event.

## Root cause

`SICardReadout.batteryVoltage` is in **volts** (`1.9 + raw × 0.09` for USB,
`mV / 1000` for Reader BT; see `docs/bugfix-siac-voltage-units.md`), but
the `storeReadout` input field `batteryVoltage` is **integer millivolts**
(`z.number().int()`, an alias for `voltageMv`, matching MeOS).
`DeviceManager.addRecentCard` forwarded the volts unchanged, so any
readout with a battery value failed validation. The USB mock in
`e2e/helpers/mock-webserial.ts` never sets a battery value, so no E2E
test exercised it; the Reader BT E2E (`e2e/reader-bt.spec.ts`), whose mock
SIAC reports 3050 mV, caught it.

The offline path was not affected: `toOfflineCardReadPayload` carries
volts by contract and the server converts with `meosFromVolts`.

## Fix

`addRecentCard` now sends `meosFromVolts(readout.batteryVoltage)`
(`@oxygen/shared`), the same helper the server uses. The Reader BT E2E
asserts `batteryVoltage: 3050` in the `storeReadout` request.

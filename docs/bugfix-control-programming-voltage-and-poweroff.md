# Bugfix: field-control programming showed stale 3.00 V and unreliable power-off

## Symptom

During control programming via BSM8 coupling mode, two issues were reproducible:

1. Controls that started asleep often reported exactly **3.00 V** after programming.
2. `Power off after programming` worked reliably on already-awake controls, but
   was flaky on freshly-awakened controls.

Additionally, the Controls table lacked a clear hardware type summary for mixed
physical units (`BSF8` + `BSF9`) assigned to one logical control.

## Root cause

### 1) Stale battery sample

`programControl()` used the first SYS_VAL read's `batteryVoltage` all the way
through to persistence and UI output.

For freshly awakened units, that first response is sometimes too early:
SPORTident BS7/8/9 firmware notes state battery voltage is measured after boot,
so the first read can expose a stale sentinel (`0x9999`), which decodes to
\(0x9999 \times 5 / 65536 \approx 3.00\) V.

### 2) OFF forwarding sequence in remote mode

The old power-off path in `webserial.ts` sent `OFF` as fire-and-forget and left
the BSM8 in remote mode.

That made freshly awakened units especially vulnerable to being re-woken by the
next coupling-coil activity in the auto-poll loop before shutdown completed.

### 3) Missing model decoding

`SYSVAL.MODEL_ID` (`0x0B`) existed in the parser offsets but was not surfaced
in `StationInfo`, persisted to `oxygen_control_units`, or shown in the UI.

## Fix

### A. Power-off flow hardened (`packages/web/src/lib/webserial.ts`)

`powerOffStation()` now:

1. Enters remote mode (`SET_MS`).
2. Waits 500 ms (fresh-boot settle window).
3. Sends `OFF` using `buildOff(true)` (remote framing, no wakeup prefix).
4. Uses `sendAndWait` (best-effort; timeout tolerated because station may sleep).
5. Returns BSM8 to direct mode (`SET_MS DIRECT`) to stop remote coupling pulses.

### B. Post-program SYS_VAL refresh (`packages/web/src/lib/webserial.ts`)

After writes (`SET_*`, `SET_TIME`, `ERASE_BACKUP`, optional `BEEP`), the code
now performs an additional `GET_SYSTEM_VALUE` and uses that parsed object as the
final `stationInfo` and persisted `batteryVoltage`.

This removed the stale 3.00 V artifact in field testing.

### C. SRR config bit-safe write (`packages/web/src/lib/webserial.ts`)

`SRR_CFG` writes were changed from full-byte overwrite (`0x00` / `0x01`) to
read-modify-write on bit 0, preserving factory/config bits in the same byte.

### D. Model and capability surfacing (`si-protocol`, API, UI)

- Added `MODEL_ID_NAMES` lookup and exposed `modelId` + `modelName` in
  `StationInfo`.
- Added capability derivation (`airPlus`, `srrHardware`, `printer`).
- Persisted `model_id` / `model_name` in `oxygen_control_units`.
- Added a **Type** column in Controls list and per-unit type rendering.
- Added translation keys in both `en` and `sv`.

### E. BSF9 identification

Field-observed model id `0x819E` is now mapped to `BSF9` in
`MODEL_ID_NAMES` (with explicit comment that this entry is field-observed and
not present in the upstream `sireader2.py` table yet).

## Tests

Added/expanded unit coverage in:

- `packages/web/src/lib/__tests__/si-protocol.test.ts`

New assertions cover:

- `parseStationInfo()` model parsing (`BSF8`, `BSF9`, unknown fallback).
- `lookupModelName()` fallback behavior.
- `deriveCapabilities()` for AIR+/SRR/printer combinations.
- Battery sentinel case `0x9999` decoding to ~3.00 V.

## Files touched

- `packages/web/src/lib/webserial.ts`
- `packages/web/src/lib/si-protocol.ts`
- `packages/web/src/lib/__tests__/si-protocol.test.ts`
- `packages/web/src/pages/ControlsPage.tsx`
- `packages/shared/src/types.ts`
- `packages/api/src/db.ts`
- `packages/api/src/routers/control.ts`
- `packages/web/src/i18n/locales/en/controls.json`
- `packages/web/src/i18n/locales/sv/controls.json`
- `docs/features.md`

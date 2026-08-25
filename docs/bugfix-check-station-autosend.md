# Bugfix: radio-equipped check stations never got autosend

## Symptom

An operator set **Radiotyp = Intern radio (SRR+)** and **Autosänd = Skicka
senaste record** on a check control, programmed the station from the
Controls page, and nothing was ever transmitted. The setting saved fine and
the dropdown kept showing it, so the UI looked correct while the station was
programmed with autosend explicitly turned *off*.

The same silent no-op hit a plain control station with an SRR module when
AIR+ was disabled for the event.

## Root cause

Two things were conflated: the autosend **variant** (which records to send)
and the autosend **gate** (whether to send at all).

- MODE byte (SYS_VAL offset `0x71`) bits 5-7 hold the variant. Config+ only
  ever emits them for the beacon modes, and SI's mode table has no
  `BC_CHECK` — beacon variants exist for control, start, finish and readout
  only.
- PROTO byte (offset `0x74`) bit 1 is the gate, and it is **mode
  independent**. Nothing transmits without it, and a non-beacon mode does
  transmit with it. `M_READOUT` already relied on exactly that.

`programControl` gated on beacon mode for both:

```ts
const autosend = isBcMode ? (config.autosendMode ?? SEND_LAST) : 0;
const wantAutosend =
  (isBcMode && autosend !== AUTOSEND_MODE.OFF) ||
  baseMode === STATION_MODE.READOUT;
const protoByte = wantAutosend ? (currentProto | 0x02) : (currentProto & ~0x02);
```

A check control programs as `STATION_MODE.CHECK` (`0x0a`), which is not a
beacon mode, so `wantAutosend` was false and the write actively **cleared**
the PROTO bit. Since SRR radio and AIR+ are separate features — short-range
radio transmission versus contactless punching — tying the gate to beacon
mode also broke SRR controls on events with AIR+ off.

The UI reinforced the illusion: the dropdown was greyed out only when the
radio type was `normal`, so for a check with radio it looked live.

## Fix

`resolveProgrammingMode()` in `packages/web/src/lib/si-protocol.ts` now owns
the MODE/PROTO decision as one pure function: the variant stays beacon-only,
while the gate follows what the operator asked for in any mode, plus the
existing `M_READOUT` special case.

```ts
const variant = beacon ? requested : 0;
const gated = requested !== AUTOSEND_MODE.OFF || baseMode === STATION_MODE.READOUT;
```

So a radio check station is written as mode `0x0a` with PROTO bit 1 set —
plain check mode, transmitting.

`packages/web/src/lib/control-station-config.ts` holds the policy side:
`resolveAutosendMode()` gates on radio type (not AIR+) and drops autosend
for clear and readout stations, and `statusSupportsAutosend()` drives the
dropdown's disabled state so the UI no longer offers a setting it will
discard. A second hint string (`autosendNotApplicableHint`) explains the
station-type case.

## Hardware caveat

The PROTO gate being mode independent is established for `M_READOUT` from a
Config+ capture (see `docs/si-protocol/readout-backup-format.md`). Check +
SRR has not been confirmed against a capture or a radio dongle — if a
programmed check station still doesn't transmit, the next step is a Config+
capture of a check station configured for radio, not a code change.

## Regression coverage

- `packages/web/src/lib/__tests__/si-protocol.test.ts` — `resolveProgrammingMode`
  across beacon/check/control/clear/readout, including the Config+ byte
  values (`0x72`, `0x32`) and PROTO bit preservation in both directions.
- `packages/web/src/lib/__tests__/control-station-config.test.ts` — variant
  mapping, radio gating, and the clear/readout exclusions.

# Bugfix: SIAC battery voltage stored in wrong units (and decoded as ~270 V)

## Symptom

The Cards page (`/Vinterserien/cards` and any other competition with cards
read by both MeOS and Oxygen) showed nonsense battery voltages on a subset
of SIAC cards — typically around **270 V** — alongside other cards reading
the expected ~3 V. The detail panel for the same cards just said
"not measured", giving a contradictory picture.

## Root cause

`oCard.Voltage` is a single integer column shared with MeOS, but Oxygen
and MeOS were using **different encodings**:

| Writer | Encoding | Example for 2.98 V |
|---|---|---|
| MeOS  | integer millivolts | `2980` |
| Oxygen (old) | raw SIAC ADC byte, with `V = 1.9 + raw × 0.09` | `12` |
| Oxygen (old) `oxygen_card_readouts.Voltage` | hundredths of a volt | `298` |

The cards-list endpoint always applied the SIAC raw-byte formula to
whatever was in `oCard.Voltage`:

```ts
batteryVoltage = 1.9 + card.Voltage * 0.09;
```

For a MeOS-written row with `Voltage = 2980` this yields
`1.9 + 2980 × 0.09 = 270.1 V`. That's the "exceptionally high" value
visible on the listing. The detail panel masked the same bug by gating
on `voltage < 255`, so it just rendered "not measured" for the same rows.

A representative pre-fix snapshot from `Vinterserien.oCard.Voltage`:

```
Voltage  Count
   2980     51   ← MeOS-written, decoded as 270.1 V
   2889     23   ← MeOS-written, decoded as 258.1 V
     13      1   ← Oxygen-written, raw ADC byte → 3.07 V
     12     13   ← Oxygen-written, raw ADC byte → 2.98 V
     11     10   ← Oxygen-written, raw ADC byte → 2.89 V
      0    123   ← never measured
```

The pairs `11 ↔ 2889` and `12 ↔ 2980` are the same physical voltage
(2.89 V and 2.98 V) — once you notice that, the unit confusion is
unambiguous.

This is a hard MeOS-compatibility violation per `AGENTS.md` §7: a card
read in Oxygen and then opened in MeOS would have shown ~12 mV (flat
battery) instead of the actual 2.98 V.

## Fix

1. **Standardise on integer millivolts** in every Oxygen voltage column,
   matching MeOS. Encoding/decoding now goes through one helper pair in
   `packages/shared/src/voltage.ts`:

   ```ts
   voltsFromMeos(2980) // → 2.98
   meosFromVolts(2.98) // → 2980
   ```

   The cards-list, cards-detail, readout-history, and `race.ts` SIAC
   battery probe paths all use these helpers — there is no longer a
   dual-decode anywhere in the read path.

2. **One-shot, idempotent migration** in
   `migrateVoltageToMillivolts(client)` (`packages/api/src/db.ts`),
   triggered by `ensureReadoutTable()`, which both card endpoints call
   before reading `oCard.Voltage`:

   - `oCard.Voltage` rows where `0 < V < 256` → `1900 + V × 90`
     (raw ADC byte → mV).
   - `oxygen_card_readouts.Voltage` rows where `0 < V < 1000` →
     `V × 10` (hundredths → mV).

   Real battery readings are always ≳ 2 V, so the value-range checks
   unambiguously identify legacy rows. Re-running the migration on
   already-mV data is a no-op.

3. **Web UI** (`packages/web/src/pages/CardsPage.tsx`):
   `BatteryDetailBlock` and `HistoryBatteryIndicator` now take
   `batteryVoltage: number | null` (already in volts) instead of
   re-deriving it from a raw integer. The `voltage` field is removed
   from the cards-list API response and the structured-search
   `CardListItem` type.

After the migration the same `Vinterserien.oCard.Voltage` distribution
becomes:

```
Voltage  Count   Volts
   3070      1   3.07
   2980     64   2.98   (51 MeOS rows + 13 migrated raw-12 rows)
   2890     10   2.89   (migrated raw-11 rows)
   2889     23   2.889  (unchanged MeOS rows)
      0    123   not measured
```

## Tests

- `packages/shared/src/__tests__/voltage.test.ts` — unit tests for
  `voltsFromMeos`, `meosFromVolts`, and the two legacy decoders,
  including round-trip and idempotence.
- `packages/api/src/__tests__/integration/voltage-migration.test.ts` —
  integration tests that seed legacy raw-byte and hundredths rows
  alongside MeOS-written mV rows, then assert the first `cardList` /
  `readoutHistory` call upgrades the columns and returns sane volts.

## Files touched

- `packages/shared/src/voltage.ts` (new)
- `packages/shared/src/index.ts` (re-export)
- `packages/api/src/db.ts` (migration + `ensureReadoutTable` hook)
- `packages/api/src/routers/cardReadout.ts` (write/read paths, list/detail)
- `packages/api/src/routers/race.ts` (SIAC battery probe)
- `packages/web/src/pages/CardsPage.tsx` (display)
- `packages/web/src/lib/structured-search/anchors/card-anchors.ts` (type)
- `packages/web/src/lib/structured-search/__tests__/new-anchors.test.ts`
- `packages/api/src/__tests__/integration/voltage-migration.test.ts` (new)
- `packages/shared/src/__tests__/voltage.test.ts` (new)

# Bugfix: Readout History Always Showed "No Punch Data"

## What happened

The Cards page detail panel has a "Readout History" section listing every
raw readout of a card (`card_readouts` is an immutable log — one row per
insertion into the reader). The section is supposed to show, per readout:
punch count and owner name in the summary row, battery voltage, and an
expandable punch table with per-control times plus card metadata
(battery date, clear count, …).

None of that ever rendered. The summary said "0 punches", the battery and
owner chips were missing, and the expanded view always fell back to
"No punch data".

## Why

`cardReadout.readoutHistory` returned only:

```ts
{ id, cardType, voltageMv, readAt, stationId }
```

while the UI component typed its prop as a hand-written `HistoryEntry`
with `punches`, `batteryVoltage`, `ownerData`, and `metadata` — and the
call site bridged the mismatch with `history.data as any`. TypeScript
would have caught the drift immediately; the cast silenced it. (The cast
was discovered during the August 2026 lint cleanup, see
`docs/lint-policy.md`.)

## The fix

**API** (`packages/api/src/routers/cardReadout.ts`): `readoutHistory` now
returns the full row — structured `punches` (absolute deciseconds, exactly
as stored by `storeReadout`), `batteryVoltage` converted from stored
integer millivolts to volts (`null` when the station reported none),
`batteryLow`, `ownerData`, `metadata`, `cardNo` — alongside the previous
fields. The JSONB columns are written verbatim from the Zod-validated
`storeReadoutInput`, so the response types simply recover that structure.

**Web** (`packages/web/src/pages/CardsPage.tsx`): `HistoryEntry` is now
inferred end-to-end from the router
(`inferRouterOutputs<AppRouter>["cardReadout"]["readoutHistory"][number]`),
so this class of drift is a compile error from now on. The component
consumes structured punches directly; the MeOS punch-string parser it
previously relied on (`parseMeosPunches`) is gone. Expansion state keys on
the readout UUID (string) instead of a numeric id that never existed.

Note: the start/finish/check header times live on the `Card` row (as
synthesized punches in `punches_raw`), not on the immutable readout log —
so history rows show control punches only. The check/start/finish rows in
the expanded table render only if the decoder itself delivered codes
1/2/3 as punches.

## Tests

- Integration (`card.test.ts`): three new tests covering the full field
  round-trip (punches in absolute deciseconds, mV → V conversion, owner
  data, metadata), the null-battery case, and newest-first ordering.
- E2E (`e2e/card-history.spec.ts`): stores a readout via the API, opens
  the card's detail panel, and asserts the summary chips (punch count,
  owner, volts) and the expanded punch table (control codes with
  HH:MM:SS times, clear count).

## Related

The selective E2E runner path (`pnpm test:e2e e2e/foo.spec.ts`) used to
run on the default ports (3002/5173) and collided with a running
`pnpm dev`. It now gets its own isolated stack (4100/4200, db
`oxygen_e2e`) — see `docs/e2e-sharding.md`.

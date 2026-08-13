# Bugfix: offline `card.read` entries drifted 10× and were never applied

Two latent bugs on the offline card-readout fallback path, found by the
step-back review that led to the architecture pivot (see the decision
record in [`offline-architecture.md`](offline-architecture.md)) and fixed
as part of the pivot's Step 1 triage.

## Symptom

Neither bug had been observed in production — the offline `card.read`
path only runs when a readout station loses connectivity mid-read, and
the queue drained rarely. Had it run:

1. A card read queued offline and drained later would have stored every
   punch time **10× too small** (a 10:00:00 punch becomes 01:00:00), and
2 . even without the unit drift, the drained entry would have been
   **journaled but never applied** — no `card_readouts` row, no card
   upsert, no runner link. The readout would silently exist only in the
   journal table.

## Root causes

**1. Seconds vs. deciseconds (web).** SI hardware speaks seconds since
midnight; the API contract is absolute deciseconds. The online path in
`DeviceManager` multiplied by 10 before calling `storeReadout`, but both
offline emit sites passed the raw `SICardReadout` values through:

```ts
// online: p.time * 10  ✓
// offline: p.time      ✗ (raw seconds queued in the outbox)
```

**2. Missing apply case (API).** The `events.push` ingestion router's
apply switch handled `finish.recorded`, `result.applied`,
`start.recorded`, `runner.registered` and `punch.recorded` — but had no
`case "card.read"`. The wire enum accepted the type, the journal row was
written, and the payload was never applied to the relational tables.

## Fix

1. **`packages/web/src/lib/offline/card-read-payload.ts` (new)** —
   `toOfflineCardReadPayload(readout, punchesFresh)` builds the outbox
   payload with all punch and header times converted to absolute
   deciseconds, mirroring the online mutation. Both emit sites in
   `DeviceManager.tsx` now use it.
2. **`packages/api/src/routers/events.ts`** — added the `card.read`
   apply case. It routes through the same `storeReadoutImpl` (now
   exported from `cardReadout.ts`) that live readouts and backup replays
   use, so a drained offline readout gets the identical pipeline:
   immutable `card_readouts` row (with `readAt` preserved from the
   original offline read time), card upsert, runner link, relevance
   score, Sheets push. Applies are guarded by the shared
   `cardReadIsDuplicate` 60-second window so two stations racing the
   drain produce one logical readout; the journal keeps both entries for
   audit. Battery voltage is converted volts → integer mV via the shared
   `meosFromVolts`.

## Tests

- `packages/web/src/lib/__tests__/card-read-payload.test.ts` — unit
  regression: punch/header times convert seconds → deciseconds; null
  header times stay `undefined`; identity/owner data pass through.
- `packages/api/src/__tests__/integration/events-push.test.ts` — pushing
  a `card.read` entry creates the readout + card rows and links the
  runner, preserving the original read time; two entries for the same
  card within 60 s apply once but journal twice.

## Files touched

- `packages/web/src/lib/offline/card-read-payload.ts` (new)
- `packages/web/src/lib/__tests__/card-read-payload.test.ts` (new)
- `packages/web/src/context/DeviceManager.tsx`
- `packages/api/src/routers/events.ts`
- `packages/api/src/routers/cardReadout.ts` (export `storeReadoutImpl`)
- `packages/api/src/__tests__/integration/events-push.test.ts`

# Bugfix: Eventor import fails on cardless runners (unique constraint on `event_id, card_no`)

## Symptom

Importing an event from Eventor (e.g. *Ungdomsserien, regionfinal SO*) aborted with:

```
Import failed: Invalid `prisma.runner.create()` invocation:
Unique constraint failed on the fields: (`event_id`,`card_no`)
```

The same failure could hit the per-event **Sync entries** action.

## Root cause

The May 2026 schema made `runners.card_no` nullable — `NULL` means "no card
assigned", replacing the legacy `0`-as-sentinel — and enforces one card per
event with a partial unique index:

```sql
CREATE UNIQUE INDEX runners_event_id_card_no_key
  ON oxygen.runners (event_id, card_no)
  WHERE removed = false;
```

The Eventor import in `packages/api/src/routers/eventor.ts` was never updated
to the new convention. It wrote:

```ts
cardNo: clampInt32(result?.cardNo || entry.cardNo)
```

which evaluates to `0` for every runner without a registered SI card. The
first cardless runner inserted `card_no = 0`; the second violated the unique
index and aborted the whole import. Youth events are full of runners without
their own cards, so the import reliably failed.

Two Eventor entries sharing the same *real* card number (loaned/shared cards,
data-entry mistakes) triggered the identical crash.

## Fix

Two helpers in `routers/eventor.ts`, applied to all four `runner.create`
sites and the sync update path:

- `normalizeCardNo(raw)` — non-positive / non-finite card numbers become
  `null` (cardless), matching the convention already used by
  `routers/runner.ts`.
- `makeCardNoClaimer(existing)` — per-pass registry guarding the unique
  index. The first runner to claim a card number keeps it; a later claim by
  a different runner gets a fallback instead: `null` on create, the runner's
  current card on sync update (so Eventor can neither steal a card that a
  locally-registered runner holds nor wipe it).

The sync path seeds the claimer with **all** non-removed runners holding
cards in the event — including locally-registered runners that have no
`eventor_person_id` — before merging the Eventor snapshot.

## Tests

- Unit: `packages/api/src/__tests__/eventorCardNo.test.ts` — normalization
  and claim/fallback semantics.
- Integration: `packages/api/src/__tests__/integration/eventor-import-cardless.test.ts`
  — reproduces the original crash (import with two cardless entries), plus
  duplicate card numbers on import, cardless results-only late entries, sync
  adding cardless runners next to an existing one, and sync not stealing a
  card held by a local runner.

# Eventor import was not atomic and wrote absolute times

Review package 5: MC-13 (also API-26, DB-20, EVT-09), RES-02 (import part),
EVT-04, EVT-11.

## What happened

`eventor.importEvent` committed the event row, then created classes, clubs and
runners one by one on the bare client.

- A failure half way (a unique violation on a card, a dropped connection) left
  an event with some of its runners. The retry hit the unique slug, and
  soft-deleting the half event did not free the slug (`events.name_id` is
  unique over deleted rows too), so the operator was stuck without database
  access. A yearly event with the same name failed the same way, with a raw
  unique violation. `event.create` did the same for a name only a deleted event
  held (EVT-11).
- Importing an already-run event stored Eventor's clock times as if they were
  ZeroTime-relative (a 10:00 start read back as 19:00), and the result position
  as the start number.
- A person entered twice, or a card shared by two entries, was fragile
  (EVT-09).

## The fix

- The slug is settled before any Eventor request: an already imported live
  event is a `CONFLICT`; a taken name (deleted events included) gets `-<year>`,
  then `-<eventor id>`. `event.create` uses the same lookup
  (`packages/api/src/event-slug.ts`).
- The event, classes and runners are written in one transaction (`createMany`
  in chunks of 500); a failure leaves nothing behind. Clubs go to the global
  directory before it (idempotent).
- Times go through `toRelative`; the start number is 0; the bib is kept. A
  person is created once; the first claimant of a card keeps it, keyed by the
  entry id.

See [system/eventor-sync.md](../system/eventor-sync.md).

## Tests

`packages/api/src/__tests__/integration/eventor-import-atomic.test.ts`: times,
start number, seq allocation with `createMany`, a failure at runner N,
re-import after a soft delete, the duplicate-event conflict before any fetch,
duplicate person and card.

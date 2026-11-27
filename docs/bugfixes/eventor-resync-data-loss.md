# Eventor re-sync cancelled finished runners and reverted desk edits

Review package 5: EVT-01, EVT-02, EVT-03, EVT-04, RES-02 (re-sync part),
API-08, API-10.

## What happened

`eventor.sync` treated Eventor as the owner of every runner it matched by
person id:

- **EVT-01 / API-10.** A runner missing from the entry list was set to
  Cancelled whatever she had done locally, and a runner that was only in the
  result list was never marked as seen, so she was cancelled on every sync. An
  empty `<EntryList/>` (a 200 with nothing in it) cancelled every runner in one
  click.
- **EVT-02.** Card, class, name, club, birth year and sex were overwritten on
  every sync. A card the desk gave a runner who had entered without one went
  back to NULL; a class move went back to Eventor's class; a runner whose class
  id was unknown here lost her class.
- **RES-02 / EVT-04.** Start and finish times were taken from Eventor's result
  as clock times: a 10:00 start was stored as `360000` where `36000` (relative to
  the 09:00 ZeroTime) was meant, so it read back as 19:00. They were then compared with the relative column, so every runner with a result counted as
  changed and was rewritten from Eventor: time, status and a start number that
  was really the finishing place.
- **EVT-03.** A failed `export/classes` request made every class lose
  `noTiming`; name, sex and age limits were overwritten on every sync.
- **API-08.** The sync ran while the event was checked out to a venue and wrote
  runners and classes without journal entries.

## The fix

The rules are in [system/eventor-sync.md](../system/eventor-sync.md). In short:

- `runners` and `classes` have an `eventor_snapshot`. A value is applied only
  when Eventor changed it since the snapshot and the local value still equals
  it; "no opinion" (card 0, unknown class, empty nationality, unknown
  no-timing) is never applied. Rows without a snapshot are not overwritten; the
  first sync seeds it.
- Times, status and start number are not written on a re-sync, and Eventor's
  result position is no longer read.
- A missing runner is cancelled only without local activity; one with a card
  read, a finish time or a result is held back and shown as "gone from
  Eventor". Results-only persons count as present. The sync reinstates only
  runners it cancelled itself. An empty entry or class list is refused.
- The sync previews first (`dryRun`), runs in one transaction and is refused
  while the event is checked out.
- "Use Eventor's value" on the runner page applies the last Eventor value as a
  journaled edit.

## Not covered

- Runners cancelled by an older sync (no snapshot) are not reinstated
  automatically when they reappear in Eventor: the sync cannot tell them from a
  hand-made cancel.
- A runner with no snapshot and an Eventor value that differs is only reported
  (counted as kept local) on the first sync.

## Tests

`packages/api/src/__tests__/eventor-merge.test.ts`,
`packages/api/src/__tests__/eventor-classes-results.test.ts`,
`packages/api/src/__tests__/integration/eventor-sync-safety.test.ts` (one case
per finding), `e2e/eventor-sync.spec.ts`.

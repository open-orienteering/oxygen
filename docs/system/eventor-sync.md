# Eventor import and sync

How `eventor.importEvent` and `eventor.sync` bring an Eventor event into Oxygen
and, above all, what a **re-sync** may and may not change. Code:
`packages/api/src/eventor-merge.ts` (the rules, no database),
`packages/api/src/routers/eventor.ts` (the procedures),
`packages/api/src/eventor.ts` (the Eventor client). Why it looks like this:
[bugfixes/eventor-resync-data-loss.md](../bugfixes/eventor-resync-data-loss.md),
[bugfixes/eventor-import-atomic.md](../bugfixes/eventor-import-atomic.md).

## The rule: Eventor changes win only over untouched values

Every runner and class carries `eventor_snapshot` (JSONB): the values the last
import or sync stored or saw. A sync applies an Eventor value only when

1. Eventor has an opinion. A card of 0, a class id unknown here, an empty
   nationality or a missing no-timing answer is "no opinion", never "clear it".
2. The local value still equals the snapshot, i.e. nobody edited it since.

Otherwise the local value stays. A row **without** a snapshot (it predates the
column) is never overwritten: the first sync after the upgrade only seeds the
snapshot and reports the difference. The snapshot follows Eventor's latest
value even when the local one is kept, so "Eventor says X" is always the last
thing Eventor said (and "Use Eventor's value" applies exactly that).

```
local == snapshot, Eventor changed   ->  write Eventor's value
local != snapshot                    ->  keep local   (counted when Eventor changed it too)
no snapshot                          ->  keep local, seed snapshot
Eventor has no opinion               ->  keep local, snapshot unchanged
```

### Runner fields

| Field | Rule |
|---|---|
| name, birth year, sex, nationality | the rule above |
| club (`eventor_club_id` + `club_name`, as a pair) | the rule, on Eventor's club id; not applied to a runner whose club name was typed at the desk (no Eventor id, name differs from the snapshot's). The runner page also shows a club renamed locally under the same Eventor id |
| class | the rule; not applied to a runner who has started (a card read, a finish time, a result status, or a start time): counted as `classChangeBlocked`, the difference stays visible; also not applied to a runner moved at the desk into a class that has no Eventor id |
| card | the rule on the **entry's** card (a result's card is not preferred on re-sync); a runner with a card read-out keeps hers; a card another runner holds is kept as is and counted (`cardConflicts`); the snapshot takes Eventor's card, so the difference stays visible as "Eventor: X" and nothing is written. A new runner whose Eventor card is held by someone else is created without a card, with Eventor's card in the snapshot. Card swaps are not resolved |
| fee, paid, taxable, rank, entry date/time, entry source | filled only when empty |
| start time, finish time, status, start number, bib | **never written on re-sync** |

Times, status and start number come from the race itself. Eventor's result
position is not a start number and is not read at all.

### Presence (runners missing from Eventor)

A person counts as present when they are in the entry list **or** the result
list (a results-only late entry is not withdrawn). **Only the first import takes results**: a re-sync creates a new entry with times 0, status Unknown (No timing in a no-timing class) and no bib, and does not create a person who is only in the results (counted as `skippedResultsOnly`, shown in the dialog). A missing runner is

- **cancelled** (status Cancelled, snapshot `present: false`) when nothing has
  happened to them locally;
- **held back** when they have a card read-out, a finish time or a result
  status: only the snapshot is marked `present: false`, the runner page says
  "gone from Eventor", the sync reports it.

A runner is identified by Eventor person id, or by entry id (`runners.eventor_entry_id`) when the entry has no person id; an entry that later gains a person id is matched by its entry id, and the person id is filled in; a second entry of the same person is counted (`duplicateEntries`), an entry with neither id is skipped and counted (`skippedNoId`). A club renamed in Eventor under the same id updates the runner's club name when it still equals the snapshot's.

A runner the sync cancelled itself is **reinstated** (status back to Unknown or
No timing) when Eventor lists them again with no result. Only the sync's own
cancel is undone (the snapshot carries `cancelled_by_sync: true`, cleared on reinstate): a runner cancelled by hand, or by a sync that predates the
snapshot, stays cancelled. A runner deleted at the desk is never brought back.

### Classes

Name, sex, age limits, no-timing flag, sort index and class type follow the
same rule. `noTiming` comes from the IOF `export/classes` request: when that
request fails or answers without a class list, every class has `noTiming:
undefined` ("no opinion"), the stored flag is left alone, the failure is logged
and the result says `detailsIncomplete`. Published course lengths still update
a shared course only when all its classes agree and the course is not
`length_source = 'derived'`.

## Snapshot format

```jsonc
// runners.eventor_snapshot  (keys optional; a partial snapshot is valid)
{ "name": "Andersson, Anna", "card_no": 500001, "class_eventor_id": 9001,
  "club_eventor_id": 1234, "club_name": "OK Test", "birth_year": 1990,
  "sex": "F", "nationality": "SWE", "present": true,
  "synced_at": "2026-11-26T12:00:00.000Z" }
// classes.eventor_snapshot
{ "name": "H21", "sex": "M", "low_age": 0, "high_age": 0,
  "no_timing": false /* null: Eventor gave no answer at creation */,
  "sort_index": 1, "class_type": "Open" }
```

The class of a runner is stored as Eventor's class id, not the local uuid. The
snapshot travels in a venue checkout like any column.

## `eventor.sync`

`sync({ dryRun?, confirmCancelIds? })` (event admin). An apply (`dryRun` false) **must** carry `confirmCancelIds` (the preview's `cancelIds`); without it the call is refused with `EVENTOR_PREVIEW_REQUIRED`, so an old client cannot apply blind. The sync takes a per-event advisory lock (`event-locks.ts`, also taken by `acquireLease`), so a checkout and a sync never interleave; the lease is re-checked after the lock.

1. **Refused while the event is checked out** (`EVENT_CHECKED_OUT`, any active
   lease, the holder's too): the sync is not journaled, so a venue would never
   see its writes. `pushResults` and `pushStartList` only read and stay
   available.
2. Classes, entries and results are fetched first; a failure aborts before any
   write. An **empty entry list** for an event with live runners, or an empty
   class list for an event with Eventor-linked classes, is refused
   (`EVENTOR_EMPTY_RESPONSE`): an odd answer is not "everyone withdrew".
3. `dryRun: true` returns the result below and writes nothing (it also leaves
   the global club directory alone). The event page always previews first and
   applies on confirm. The apply sends the previewed `cancelIds`; if the sync would cancel a runner who was not in the preview it is refused with `EVENTOR_PREVIEW_CHANGED` and nothing is written (a smaller set is fine).
4. Otherwise everything is written in **one transaction** (the lease is
   re-checked inside it, `timeout` 60 s), then variants are reconciled and the
   last-sync time set. Sync writes are not journaled.

```ts
{ dryRun,
  classes: { added, updated, keptLocal, detailsIncomplete },
  clubs: { added, updated },
  runners: { added, updated, keptLocal, wouldCancel, heldBack, reinstated,
             classChangeBlocked, cardConflicts, duplicateEntries, skippedNoId,
             skippedResultsOnly },
  cancelIds: string[],                                      // runners cancelled / to cancel
  samples: { wouldCancel: string[], heldBack: string[] } }  // at most 20 names each
```

`wouldCancel` is what the sync cancelled, in a preview what it would cancel;
`keptLocal` counts runners with a local value kept over an Eventor value that
is new to us.

## `eventor.importEvent`

All or nothing, in this order:

1. The slug is settled **before any request**: the same Eventor event already
   imported and live is a `CONFLICT`; a name a soft-deleted event still holds
   gets `-<year>`, then `-<eventor id>` (the slug is unique over deleted rows).
   `event.create` uses the same lookup for a name only a deleted event holds.
2. Fetch, then upsert clubs into the global directory (idempotent, outside the
   transaction).
3. The new event's ZeroTime is set from the earliest result start (rounded down to the hour, minus one hour, at least 0; 09:00 when there are no results). One transaction (120 s) writes the event and meta rows, the admin grant, the
   classes, the runners (`createMany` in chunks of 500, snapshots filled), the
   class fees and the last-sync time. A failure leaves no event behind.
4. Results are stored like everywhere: start and finish **ZeroTime-relative**
   (`toRelativeWrapped`, wrapped into 0..24 h), start number 0, bib from the result. A person's second entry is created once and counted; an entry without a person id is created, keyed on its entry id.  a duplicate card goes to the first claimant, and the entry id
   (`entry:<id>`) keys the claim.

The client navigates with the returned `nameId`, which can carry the suffix.

## Seeing and using the difference

- `runner.getById` returns `eventorDiff` (field, local value, Eventor's value;
  classes and clubs by name) and `goneFromEventor`; `runner.list` rows carry
  `differsFromEventor` / `goneFromEventor`. One function
  (`runnerEventorDiff`) computes both.
- The runner page shows "Eventor: X" with **Use Eventor's value** under a field
  that differs. `runner.useEventorValue({ runnerId, field })` writes the
  snapshot value through the ordinary journaled runner edit; a card held by
  another runner is a `CONFLICT`.
- The runner search has an `eventor` filter: `eventor:differs`,
  `eventor:gone`; the list shows a small badge.

## Tests

`src/__tests__/eventor-merge.test.ts` (the rules),
`integration/eventor-sync-safety.test.ts` and
`integration/eventor-import-atomic.test.ts` (one case per review finding, each
headed with what the old code did), `e2e/eventor-sync.spec.ts` (preview,
confirm, marker, use value, filter; the stub's scenarios are in
[dev/e2e-eventor-stub.md](../dev/e2e-eventor-stub.md)).

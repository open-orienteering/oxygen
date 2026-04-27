# Consistent cancellation (Status=21) handling

## Symptom

Looking at the Bagissprinten dashboard with 58 runners, the "Finished"
counter showed `2` even though no one had crossed the finish line yet.
The two "results" turned out to be Eventor-imported entries that had
been withdrawn (Återbud, MeOS `Status = 21`). The result list also
showed those two runners as `Cancelled` rows with no time, which made
it look like the result list was leaking pre-race data.

## Root cause

MeOS encodes a withdrawn entry with `Status = 21 (Cancel)` rather than
soft-deleting it (`Removed = 1`). Oxygen's various "is this person
finished / part of the race" checks all collapsed every non-zero
status into one bucket:

```ts
const hasResult = r.Status > 0;            // older code
if (hasResult || hasFinishTime) finished++; // counted Cancel as finished
```

`Status > 0` is true for `OK (1)`, `MP (3)`, `DNF (4)`, `DQ (5)`,
`OverMaxTime (6)`, `OutOfCompetition (15)` — but **also for `DNS (20)`
and `Cancel (21)`**. The same logic was duplicated across the dashboard
counts, the runner list `statusFilter`, the result-list / start-list
endpoints, the per-class / per-club counts, the LiveResults push, and
both structured-search anchors.

Two further issues fell out of the same investigation:

1. **No way to filter by Cancel** — the `STATUS_ALIASES` table in both
   anchors already mapped `cancel`, `overtime`, `nc` to numeric
   statuses, but the suggestion dropdown only listed `ok / mp / dnf /
   dns / dq / not-started / in-forest / finished`. `status:cancel`
   worked if you typed it, you just couldn't discover it.

2. **Re-entry was sticky** — `routers/eventor.ts` correctly stamps
   missing-from-snapshot runners with `Status = 21`, but the re-entry
   path (the `if (existing)` branch around line 640) only updates
   `Status` when the snapshot includes a `result`. A previously-
   cancelled person who re-entered without a result yet would keep
   `Status = 21` forever — silently invisible from every list now that
   Cancel is excluded.

## DNS vs Cancel — the design rule

After this change Oxygen distinguishes the two:

| Status | Meaning | Counted as participant? | Pays / reported to Eventor? | On result list? | On start list? |
|---|---|---|---|---|---|
| `DNS` (20) | Paid no-show | yes | yes | yes | yes |
| `Cancel` (21) | Withdrawn entry (Återbud) | no | no | no | no |

`Cancel` is *not* turned into `Removed = 1`. The four reasons that came
out of the discussion:

1. **Payment / refund state** lives on the `oRunner` row (`Fee`,
   `Paid`, `PayMode`, `Taxable`, `CardFee`, `CardReturned`). Hard
   delete loses it; organizers need it to issue refunds and chase
   rental cards.
2. **MeOS bidirectional compatibility** (AGENTS.md §7) — MeOS itself
   uses `Status = 21` for withdrawals, not `Removed = 1`. The two
   flags mean different things in MeOS (`Removed` = user-deleted
   tombstone; `Cancel` = withdrawn entry that still belongs to the
   competition).
3. **`Removed` semantic overload** — `Removed = false` is the
   universal "live row" filter across the codebase. Reusing it for
   "withdrawn" would create subtle bugs in any sync / diff logic.
4. **Audit trail** — `EntryDate`, `EntryTime`, `EntrySource`,
   `Annotation` survive a withdrawal.

## Fix

### 1. Shared helpers in `@oxygen/shared`

`packages/shared/src/types.ts` exposes the rule once and uses it
everywhere:

```ts
export const RACE_RESULT_STATUSES = [
  RunnerStatus.OK, RunnerStatus.NoTiming, RunnerStatus.MissingPunch,
  RunnerStatus.DNF, RunnerStatus.DQ, RunnerStatus.OverMaxTime,
  RunnerStatus.OutOfCompetition, RunnerStatus.DNS,
  RunnerStatus.NotCompeting,
];
export const WITHDRAWN_STATUSES = [RunnerStatus.Cancel];
export const IN_FOREST_EXCLUDED_STATUSES = [
  RunnerStatus.NoTiming, RunnerStatus.DNS, RunnerStatus.Cancel,
  RunnerStatus.NotCompeting, RunnerStatus.OutOfCompetition,
];
export function isWithdrawn(s): boolean { return s === RunnerStatus.Cancel; }
export function isParticipant(s): boolean { return !isWithdrawn(s); }
export function isFinished(s, finishTime): boolean {
  if (RACE_RESULT_STATUSES.includes(s)) return true;
  return s === RunnerStatus.Unknown && finishTime > 0;
}
```

`StatusCounts` gained a `cancelled: number` field so the dashboard can
report withdrawals separately from the three race buckets.

### 2. API surfaces using the helpers

| File | Change |
|---|---|
| `routers/competition.ts` (`dashboard`) | `totalRunners` is the participant count; `statusCounts.cancelled` is now populated; `totalClubs` only counts clubs with at least one participant; per-class `runnerCount` excludes Cancel. |
| `routers/competition.ts` (`clubs`) | Excludes clubs whose only runners are all cancelled. |
| `routers/runner.ts` (`list`) | Status-filter "finished" / "in-forest" / "not-started" all delegate to `isFinished`. Cancel rows are still returned (entries view). |
| `routers/lists.ts` (`resultList`, `startList`, `classes`) | Cancel rows excluded from list output and per-class counts. |
| `routers/classRouter.ts` | Per-class participant counts exclude Cancel. |
| `routers/clubRouter.ts` | Per-club participant counts exclude Cancel; clubs that drop to zero are hidden by the existing `showAll=false` filter. |
| `routers/drawRouter.ts` + `draw/drawEngine.ts` | The draw never assigns a slot to a Cancel entry. |
| `routers/course.ts` | `IN_FOREST_EXCLUDED_STATUSES` replaces an inline `notIn` list; `isFinished` replaces a duplicated `Status > 0 || FinishTime > 0` predicate; class-runner counts exclude Cancel. |
| `liveresults.ts` | The cleanup-delete path scrubs Cancel rows from LiveResults entirely instead of merely collapsing them to DNS. |

### 3. Web

- `result-anchors.ts` and `runner-anchors.ts` use the shared helpers
  for `not-started` / `in-forest` / `finished` matching, expose
  `withdrawn` as a synonym for `cancel`, and added the missing
  `overtime`, `cancel`, `oc`, `nc` entries to the suggestion dropdown.
- `RunnerManagement.tsx` shows `"56 active · 2 withdrawn"` in the
  header whenever the visible rows include any Cancel entries
  (`runners:activeAndWithdrawn` key, en + sv). The Cancel rows stay
  inline with the existing `StatusBadge`.

### 4. Eventor re-entry status reset

`routers/eventor.ts` — in the `if (existing)` branch the
`needsUpdate` predicate now treats `existing.Status === Cancel` as a
signal that the runner is being reinstated. The update payload sets
`Status = entry.noTiming ? 22 : 0` when no `result` is present,
mirroring the create-branch default. If the snapshot does include a
result, the existing `result.status` path takes precedence.

## Tests

- `packages/shared/src/__tests__/types.test.ts` — unit coverage for
  `isWithdrawn`, `isParticipant`, `isFinished`, and the constant sets.
- `packages/api/src/__tests__/integration/cancellation-handling.test.ts`
  — full-stack assertions: dashboard counts, result list, start list,
  per-class / per-club counts, runner.list filter behavior. Seeds
  five OK + one DNS + two Cancel + one unstarted runner across two
  clubs.
- `packages/api/src/__tests__/integration/eventor-reentry.test.ts` —
  three scenarios: a Cancel runner reappears as an entry → Status
  resets to 0; same path with `noTiming` class → Status resets to 22;
  Cancel runner still missing → Status stays 21.

## What is intentionally not changed

- `Cancel` is still preserved in the `oRunner` row, with `Removed =
  false`. The Eventor sync logic that flips `Status = 0 → 21` for
  missing entries (lines 775–793) is untouched.
- `DNS` behavior is unchanged: still counted as finished, still
  returned by the start list and result list, still pushed to
  Eventor.
- The `Cancel` rows still ship in the offline cache (the runners page
  needs them to render the "X active · Y withdrawn" header).

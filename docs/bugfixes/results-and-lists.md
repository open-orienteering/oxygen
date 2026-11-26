# Ties got different places, and the receipt, the offline readout and the Eventor upload disagreed with the result list

Fix package 13 of the November 2026 full review (RES-11 with MC-14, DB-19,
CRS-011; RES-20 with SI-21, CRS-045; RES-21 with API-20; CRS-039; CRS-042;
CRS-013).

## What happened

**The result list gave ties consecutive places.** `lists.resultList` sorted
by running time and counted `place++`, so two runners on 45:12 got 1st and
2nd in whatever order Postgres returned them, which could flip on the next
refresh. The Eventor upload (`computeClassPlacements`) gave both 1st, and so
did each receipt. The list also ignored `Class.noTiming` (it ranked
no-timing classes, and the "Unofficial" badge on the Results page never
showed), ranked all classless runners together as one class, read only the
newest card (not the linked one) and no free punches for the NoTiming-leg
deduction, and computed the time as `finish - start`, so a run across
midnight had none.

**The receipt position used raw times.** `race.finishReceipt` counted
faster peers in SQL on raw `finish - start`, while the result list deducts
NoTiming legs: a runner first on the list could be told 2/2. The SQL only
counted rows already stored as OK, so the first finisher (whose result is
not saved yet when the kiosk asks) got no position at all, and a no-timing
class still got positions.

**The receipt's Fin row repeated the last control.** Both printer builders
took the last split's time and leg length for the Fin row, so a 0:25 run-in
after a 2:10 leg printed 2:10 twice.

**In-forest and not-started filters never matched on the Results page.**
`resultList` did not return `hasPunches` or `hasStarted`, which the filters
read.

**The offline readout never applied no-timing or max time.** It tested
`noTiming === 1` on a boolean, the dashboard sent no `maxTime`, and the
position counted mispunched and disqualified peers and was given whatever
the runner's own status.

**The Eventor upload reported unfinished runners as DidNotStart or OK.** A
runner with status Unknown went up as `DidNotStart` without a finish time
and `OK` (with no time or position) with one, so a mid-event upload marked
everyone in the forest as not started.

## The fix

- `packages/api/src/classStandings.ts` (`loadClassStandings`) is the one
  standings step: stable order, the readout's card choice
  (`pickRunnerCard`) plus free punches, the matcher's deduction, and
  `computeClassPlacements` per class. Cancelled entries are left out (as
  `cancellation-handling.md` already said; the filter had gone missing;
  the Results page's "Cancelled" filter value is gone with them), except
  the runner a receipt is printed for,
  and classless runners are unplaced. `resultList` and `finishReceipt` both
  use it; the receipt substitutes its own readout row so rank and total are
  right before the result is saved, and returns `null` for a no-timing
  class.
- `computeClassPlacements` no longer ranks an OK runner whose deduction
  leaves no time.
- The result list returns the time for NoTiming, OverMaxTime and
  OutOfCompetition rows (unplaced) and sets `noTiming` for no-timing
  classes; MP, DNF and DQ rows show no time. Rows come per class (sort
  index), placed runners by place, then timed unplaced runners, then the
  rest.
- `runnerProgress.ts` computes `hasPunches` / `hasStarted` for both lists.
- `finishReceipt` and the offline card readout return
  `finish: { splitTime, legLength }` from the shared `finishLegOf`: on an
  ordered course the last timed control (or the start) to the finish, with
  `legs[controls.length]`; nothing when that control was missed; on a
  free-order course the split from the latest punch, with no length. Both
  builders print it; without it the Fin split and pace are blank.
- The dashboard sends `ClassInfo.maxTime`; the offline readout tests
  `noTiming === true`, ranks only against OK peers, gives a position only
  to an OK result, and uses the midnight-safe `runningTimeDs`. The
  Finish Station's offline receipt gives tied runners the same rank.
- `meosStatusToIof` maps Unknown to `Finished` (finish time), `Active`
  (started by the clock or punches read) or `Inactive`, and drops the dead
  OutOfCompetition ternary.

No migration.

## Tests

- `integration/result-standings.test.ts`: ties (1, 1, 3, stable), no-timing
  class, DQ, classless and cancelled rows, a start before ZeroTime, progress
  flags, the receipt's adjusted rank, the unsaved first finisher, ties and
  no-timing on the receipt, the finish leg, and the dashboard's `maxTime`.
- `escpos.test.ts`: the Fin row prints the finish leg, blank without one.
- `local-readout.test.ts`: no-timing, max time, OK-only peers, no position
  on MP.
- `eventor-upload.test.ts`: Unknown → Inactive / Active / Finished, no
  Time or Position.

Left out: [results-and-lists-followups.md](results-and-lists-followups.md).

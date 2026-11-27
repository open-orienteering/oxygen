# Test Lab could wipe a live event; unchecked statuses and times; dead endpoints (package 19)

Review items API-06, API-34, API-13 (rest) and RES-24 (rest).

## What happened

- **API-06.** Every `testLab.*` procedure needed only `event.manage`. One click
  on **Clear runners** (or a stray `generateReadout`, `registerRunners`,
  `startSimulation`) on a real event deleted its runners or wrote synthetic
  cards and results into it, unjournaled and outside the lease. The Test Lab
  tab was shown on every event.
- **API-34.** `testLab.generateEvent` was a `publicProcedure`: anyone who could
  reach the API could create events full of fictional runners. It had no
  callers. `testLab.defaults` was public too.
- **RES-24 (rest).** `race.recordFinish` and `cardReadout.applyResult` took any
  integer as status and time. `valueToRunnerStatus` turned an unknown number
  (7, 999) into `unknown`, and `999999999` was stored as a finish time. The
  same went for `finish.adjusted` and `result.applied` journal entries applied
  by `events.push`, and for the status inputs of `runner.*`.
- **API-13 (rest).** `kioskOrRaceOperateRaceProcedure` stayed in `trpc.ts` with
  no users.

## What package 2 had already closed

- API-13, kiosk access: `race.recordFinish` is `raceOperateRaceProcedure`, with
  the `FINISH_EXISTS` guard; a kiosk key cannot call it
  (`permissions.test.ts`, "kiosk key").
- MC-25: the split of the race procedures and the journal actor, and the
  `docs/system/authentication.md` description of both.
- RES-24, the kiosk half: a kiosk-key device could not apply results.

## Fix

- **Test event flag.** New column `events.is_test_event` (migration
  `20261127120000_event_is_test_event`, additive, default false). Set with
  `event.setTestEvent({ enabled })` (`event.manage`) or the optional
  `isTestEvent` of `event.create`. Turning it on is refused
  (`PRECONDITION_FAILED`) with an Eventor link, any card readout, or an active
  lease; turning it off is always allowed and stops a running simulation. It
  is a cloud-owned column (forwarded during a lease; `EVENT_ROW_WRITERS`,
  `CLOUD_OWNED_MUTATIONS`, `SETTINGS_REFRESH_PATHS`) and part of `EventInfo`.
- **Guard.** `testEventProcedure` (`manageProcedure` plus a fresh read of the
  flag, `NOT_A_TEST_EVENT`) on `clearRunners`, `startSimulation`,
  `updateSpeed`, `generateReadout`, `generateClasses`, `generateCourses`,
  `registerFictionalRunners`, `registerRunners` and `pushBackupPunch`.
  `stopSimulation` and the queries stay open, so a simulation can always be
  stopped and the page can read its status. A timed simulation no longer
  overlaps its own ticks and re-checks the flag on each tick, so clearing it
  halts the timer. `stopSimulationFor(eventId)` is exported for
  `event.setTestEvent`.
- **Web.** The Test Lab tab exists only when `isTestEvent` is true
  (`computeTabLayout`); the page on a real event (direct URL) shows a notice
  with a link to Event settings; Start simulation asks for confirmation; a
  **Test event** switch in Event settings, a checkbox in the create dialog and
  a badge in the shell header.
- **API-34.** `testLab.generateEvent` deleted; `testLab.defaults` is now
  `manageProcedure`.
- **RES-24.** `runnerStatusValueSchema` (an integer that is a `RunnerStatus`
  constant) on `race.recordFinish`, `cardReadout.applyResult` and the `runner`
  status inputs; `absoluteTimeSchema` (0..863999, as `event.create`'s
  `firstStart`) on `recordFinish.finishTime` / `finishTimeAbsolute` and
  `applyResult.finishTime` / `startTime`. Those times are absolute deciseconds
  since midnight, so the bound is a day, not ZeroTime-relative. In
  `events.push`, a `finish.adjusted` / `result.applied` entry with an unknown
  status or an out-of-range time is refused as `INVALID_PAYLOAD` and writes
  nothing.
- **API-13.** `kioskOrRaceOperateRaceProcedure` deleted.

## Tests

`testlab.test.ts` (every guarded procedure refused and nothing changed,
`stopSimulation` and queries open, flag read fresh, clearing it stops a timed
simulation and halts a tick, `generateEvent` gone), `event.test.ts`
(`setTestEvent`), `permissions.test.ts`, `journal-emit.test.ts` and
`events-push.test.ts` (status and time validation), `lease.test.ts` and
`backup-restore-roundtrip.test.ts` (the column travels), `statusConvert.test.ts`,
`shell-tabs.test.ts`, and `e2e/test-lab.spec.ts`.

Follow-ups left out: [test-lab-followups.md](test-lab-followups.md).

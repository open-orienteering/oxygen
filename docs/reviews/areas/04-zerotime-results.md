# Area 04: ZeroTime, results, statuses, start lists and draw

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Reviewed on `main` at `df5460c3`, plus the PR 254 diff (`claude/project-thread-avzbks`) where it touches this area. Review only: no code was changed.

**Scope:** ZeroTime relative/absolute conversion (`timeConvert.ts`) and every consumer of it; runner status handling and the MeOS-code/enum mapping; result computation, ranking and ties (result list, receipt, Eventor upload, LiveResults, offline readout); start lists, the start screen and station clocks; the draw (`packages/api/src/draw/`, `drawRouter.ts`, `DrawPanel.tsx`); team/relay results.

**Method:** two Fable reviewers read the area in full (one for times/status/results, one for start lists and the draw). Their 37 findings went to seven fresh Fable verifiers, each given only the locations and claims (never the reviewer's reasoning) and told to disprove them. To stay within the agent limit, a verifier took 3 to 8 related claims and judged each one on its own. Verifiers re-ran the pure modules (`optimizer.ts`, `algorithms.ts`, `timeConvert.ts`, `shared/src/readout.ts`, `results.ts`, `types.ts`) in scratch scripts. `pnpm install` failed in the container (a 403 on the `ocad2geojson` GitHub tarball), so no vitest, integration or E2E run was possible, and nothing touched a database.

**Result:** one claim was refuted and dropped (`events.ts:356` is a `=== 0` test, not `> 0`). Two were dropped as intended design (club key 0 for clubless runners, warned at `drawEngine.ts:135-141`) or left unverified (the draw-timeline block width). Overlapping claims from the two reviewers were merged, which leaves 35 findings.

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 11 |
| Medium | 14 |
| Low | 7 |

**Fix first:**
1. **RES-01:** re-reading a card overwrites an existing result, including DQ and manual corrections.
2. **RES-02:** an Eventor re-sync after results have been uploaded rewrites every runner's start, finish and status with times shifted by ZeroTime.
3. **RES-03:** a redraw silently rewrites the start times of runners who have already finished.
4. **RES-04 and RES-05:** fix the ZeroTime "0 = no time" sentinel together. A start exactly at ZeroTime, which is the draw's default, is lost, and starts before ZeroTime vanish from the start screen, LiveResults, receipt rank and the Eventor positions.
5. **RES-07 and RES-08:** journal replay turns DQ, no-timing and over-time statuses into Unknown on the cloud copy, and backup-memory punches are stored with the wrong time base.

Team and relay results, chasing/pursuit starts, multi-stage totals, vacancies and start-time locking do not exist in the code. The `Team` model and related columns are never read (RES-33).

---

## Critical

### RES-01 Re-reading a card overwrites an existing result
- **Area / category:** readout → results; functional, stability.
- **Location:**
  - `packages/web/src/context/DeviceManager.tsx:449-466`: `hasDbResult` forces `action = "readout"`.
  - `DeviceManager.tsx:503-510`: auto-apply, no dialog.
  - `DeviceManager.tsx:519-529`: offline fallback queues the same values.
  - `packages/api/src/routers/cardReadout.ts:805-856`: `applyResult` selects `runner.status` but never uses it.
  - `cardReadout.ts:556-567`: `punchesRaw` is overwritten unconditionally.
  - `cardReadout.ts:411` and `:738`: `punchesFresh` is accepted and never read.
  - `packages/shared/src/readout.ts:548-560`: `computeStatus`.
- **What is wrong:** whenever the runner already has a result, any read of the card is applied as a readout, with no confirmation. The status, start and finish are recomputed from the card and written over whatever is stored. `computeStatus` uses the current status only when the run has a finish, no missing controls and a running time of 0 or less. The duplicate check (`DeviceManager.tsx:316-320`) only skips `storeReadout`; `applyResult` still runs. The freshness check (`:186-215`) only affects what is displayed.
- **Scenarios** (all confirmed from code):
  - A jury DQs a runner, who then reads the card again for a second receipt. The status goes back to OK and the runner is ranked. The same happens to any manually set status.
  - An organiser corrects MP to OK by hand. A re-read sets it back to MP.
  - A finished runner's card is cleared (rental return, or any clear/check) and put into a reader. `punchesRaw` becomes empty and `applyResult` writes DNF with finish 0 over the OK result. An exception is when a radio or manual finish punch exists in `punches`.
  - A card holding old punches that match at least 20% of today's course (`readout.ts:177-187`) is read before the start. The old status and finish are written. For runners using a punched start (no drawn start), the stale start sticks, because the stored start wins over the card's start punch (`readout.ts:325`). The real readout then times the runner from that stale start.
  - The old values exist only in the `card_readouts` log, and nothing restores them.
- **Fix (M):** move the decision server-side into one `applyReadout` mutation.
  - Never overwrite DQ, or a status or time marked as manual. Add a `statusManual` flag set by `runner.update` and the status buttons.
  - Refuse to replace a result when the new read has no finish, an empty punch list, or `punchesFresh === false`. Return `needsConfirmation` and have the UI ask.
  - Do not overwrite `cards.punches_raw` with an empty read once the runner has a result.
  - Add integration tests for each scenario above.
- **Verdict:** confirmed (proven from code). The reviewer reproduced `computeStatus` returning OK over DQ, and DNF for an empty card. The verifier walked each scenario and found no guard; the stale-card scenario is narrower than first claimed, as described above.

### RES-02 Eventor import writes absolute times into ZeroTime-relative columns, and a re-sync overwrites every runner
- **Area / category:** Eventor import → times; functional (data corruption).
- **Location:**
  - `packages/api/src/eventor.ts:332-340` and `:963-964`: `timeToMeosDs` returns time since midnight.
  - Stored without `toRelative` at `packages/api/src/routers/eventor.ts:802-803`, `:844-845`, `:1082-1083`, `:1127-1128` and `:1172-1173`.
  - Re-sync at `routers/eventor.ts:942-945` and `:1041-1085`.
  - Readers add ZeroTime, for example `runner.ts:260-261`.
- **What is wrong:** start and finish times taken from Eventor's `results/event` are stored as clock time in columns that every reader treats as relative to ZeroTime. In the re-sync, `needsUpdate` compares the relative stored value with the absolute Eventor value, so it is always true and every existing runner is rewritten from Eventor.
- **Scenario:** results are uploaded to Eventor mid-event, then the organiser runs an Eventor re-sync to pull late entries.
  - Every runner's start, finish and status is replaced by Eventor's copy, so local corrections made after the upload are lost.
  - All times shift by +9 h. A 10:00 start reads back as 19:00.
  - For starts after about 15:00 the shifted value wraps past midnight, so finish < start and the running time is 0.
  - Readout matching gets a wrong fallback start, so splits are wrong.
  - Importing an already-run event shows the same +ZeroTime shift. A plain pre-event entry import (no results yet) writes 0 and is unaffected.
- **Fix (M):**
  - Apply `toRelative(…, event.zeroTime)` on all five writes.
  - Compare like with like in `needsUpdate`.
  - Separately decide whether a re-sync may overwrite local results at all. Suggested: never overwrite a runner that has a local readout or a non-Unknown status, and import only entries and cards.
  - Add an integration test: import with results, then check that the start list shows the Eventor clock times; re-sync after a local correction, then check that the correction survives.
- **Verdict:** confirmed (proven from code by the verifier who found it as a side lead). This area's reviewer did not cover it; the Eventor-area review should cross-check it.

### RES-03 A redraw rewrites the start times of runners who have already started or finished
- **Area / category:** draw; functional (data corruption).
- **Location:**
  - `packages/api/src/draw/drawEngine.ts:75-81`: the runner filter is only `removed: false` and not withdrawn.
  - `packages/api/src/routers/drawRouter.ts:165-170`: unconditional write of `startTime` and `startNo`.
  - `packages/web/src/components/DrawPanel.tsx:104`: every non-free-start class is preselected.
  - `DrawPanel.tsx:260-269` and `:708-713`: Apply has no confirmation.
- **What is wrong:** `draw.execute` overwrites start time and start number for every selected runner, including those with a finish time, a status, punches or a hand-set start.
  - Results compute finish minus start live (`packages/shared/src/results.ts:107-110`, `lists.ts:159,172`).
  - A later re-readout does not repair it, because the stored start wins over the card's start punch (`readout.ts:325`) and is persisted again (`cardReadout.ts:907-913`).
- **Scenario:** mid-event, the organiser opens Draw to give a late class times. All classes are preselected; they press Preview, then Apply. Every finished runner's running time changes, or goes negative and drops out of the results. The old values survive only in earlier `start.adjusted` journal rows.
- **Fix (M):**
  - Server: skip runners with `finishTime != 0`, a status other than Unknown, or a read card, unless `force: true`, and return the count skipped.
  - Add an "only runners without a start time" mode for late entries.
  - UI: preselect only undrawn classes, and when a selected class already has start times, confirm with the number that will be replaced.
  - Integration test: a finished runner's start time survives a redraw.
- **Verdict:** confirmed (proven from code). It takes two deliberate clicks (Preview, then Apply).

## High

### RES-04 A start exactly at ZeroTime is stored as "no start time", and the draw defaults to ZeroTime
- **Area / category:** time conversion, draw; functional.
- **Location:**
  - `packages/api/src/timeConvert.ts:15-17` and `:24-25`.
  - `packages/api/prisma/schema.prisma:106`: `zeroTime` defaults to 324000, which is 09:00.
  - `packages/web/src/components/DrawPanel.tsx:112-115` and `:182`: First start is pre-filled from ZeroTime.
  - `packages/api/src/routers/drawRouter.ts:168` and `:192`.
  - The same applies to manual entry at `routers/runner.ts:119-121`, `:437-440` and `:681-685`, and at `routers/events.ts:403`, `:424` and `:438`.
- **What is wrong:** relative 0 means both "exactly ZeroTime" and "no time". No application code ever writes `events.zero_time`:
  - `event.create` (`event.ts:264-272`) and the Eventor create (`routers/eventor.ts:695-706`) leave it out, and there is no UI to change it.
  - Only the MeOS migration script, backup restore and `settingsRefresh` copy it.
  - So every Oxygen-created event has ZeroTime 09:00, and the draw panel proposes 09:00 as the first start.
- **Scenario:** a new event, with the draw run on its defaults (09:00:00, stagger 0).
  - The first runner of the leading class in every corridor gets `startTime = 0`. With a non-zero stagger, only corridor 0 is hit; a mass start at 09:00 hits the whole class. `class.firstStart` is stored as 0.
  - Those runners show "-" on the start list and are missing from the start screen and LiveResults.
  - At readout they have no start. Without a start punch, running time is 0, `computeStatus` keeps Unknown, and the runner never gets a result.
  - Typing 09:00:00 as a runner's start time clears it in the same way.
- **Fix:**
  - Short term (S): set ZeroTime at event creation to one hour before the planned first start (as MeOS does), make it editable before the draw, and reject a draw or edit whose relative start is 0.
  - Proper (M–L): make `start_time` and `finish_time` nullable, with a migration, and remove the sentinel.
  - Tests: `toRelative(zero, zero)`; a draw at ZeroTime gives every runner a start time.
- **Verdict:** confirmed (reproduced). Two scratch runs gave `toRelative(324000, 324000) = 0`, which reads back as 0. A grep confirmed that nothing writes `zeroTime`.

### RES-05 Comparisons with `> 0` on relative times drop runners who start before ZeroTime
- **Area / category:** time conversion, results exposure; functional.
- **Location and effect** (each confirmed):
  - `packages/api/src/routers/event.ts:724`: the start screen filters on `startTime: { gt: 0 }`.
  - `event.ts:438-439`, `routers/lists.ts:70-72` and `routers/runner.ts:369-371`: `hasStarted` and the in-forest counts.
  - `packages/api/src/liveresults.ts:421`, `:445`, `:458-461` and `:471`: the runner is skipped, gets no start row, or is pushed as OK with time 0 and no radio splits.
  - `packages/api/src/routers/eventor.ts:1661-1662`: relative times go into `computeClassPlacements`, which filters on `> 0`, so an OK runner is uploaded without a Position (time and status still go up).
  - `packages/api/src/routers/race.ts:229-230` and `:247-248`: these runners are left out of the receipt's rank and total. `race.ts:108` has the same issue for the recent-finishers list.
- **Scenario:** an event with first start 08:30 (ZeroTime is fixed at 09:00, RES-04). Early starters are missing from the call-up screen, never count as in the forest, show 0:00 on LiveResults and get no place in Eventor, while the local result list (which uses absolute times) ranks them correctly. The organiser cannot work around it, because ZeroTime is not editable.
- **Fix (S–M):** add a shared `hasTime(rel)` helper (after RES-04, simply `rel !== null`) and use it at every site; in `eventor.ts:1661`, pass `toAbsolute` values as `lists.ts` does. Add a test with a start before ZeroTime for each consumer.
- **Verdict:** confirmed (reproduced). `toRelative(306000, 324000) = -18000`, and `computeClassPlacements` gives place 0 to an OK runner with a negative relative start.

### RES-06 Station clocks and "has started" use the server process time zone; the Docker images run in UTC
- **Area / category:** time conversion, start/finish stations; functional, stability.
- **Location:**
  - `packages/api/src/routers/race.ts:87-93` uses `Date#getHours`. Its docstring says "event's local timezone".
  - `routers/lists.ts:50-52`, `event.ts:399-401`, `runner.ts:353-355` and `timeConvert.ts:33-46` (entry time).
  - `packages/web/src/pages/StartStation.tsx:17-19`, `:39` and `:140-143`; `KioskPage.tsx:1152-1158`; `FinishStation.tsx:36-38`.
  - `Dockerfile:2` and `:122`: `node:24-slim`, with no `TZ` set anywhere in Docker, compose, scripts or docs.
- **What is wrong:**
  - The time of day is the API process's local time, so in the Docker or Cloud Run images it is UTC.
  - The station clocks have no local tick: they show the value polled every second, 0 before the first response, and a frozen value without network.
  - `StartScreenPage.tsx` uses the browser clock, so the two start views disagree.
- **Scenario:** the Docker stack in Sweden in summer.
  - The start station shows 08:00 at 10:00 and "120 min to start" for a runner due now.
  - `hasStarted` and the in-forest counts lag by two hours.
  - On poor Wi-Fi the countdown freezes, although the station is documented as working offline.
  - `pnpm dev` on a laptop set to local time is not affected.
- **Fix (M):**
  - Store an IANA time zone on the event (default `Europe/Stockholm`) and compute the time of day with `Intl.DateTimeFormat`. At minimum, set `TZ` in the images and compose files and document it.
  - In the stations, fetch the server time occasionally and tick locally from the offset.
- **Verdict:** confirmed from code. It was not run in a container.

### RES-07 Journal replay of `result.applied` turns every status except OK, MP and DNF into Unknown
- **Area / category:** status handling, sync; functional.
- **Location:**
  - `packages/api/src/routers/events.ts:391-413`; the ternary at `:404-411` maps only 1, 3 and 4.
  - `valueToRunnerStatus` is imported at `:43` but used only for `finish.adjusted` (`:383`).
- **What is wrong:** `applyResult` (`cardReadout.ts:844`), variant accept (`:927`) and the offline fallback (`DeviceManager.tsx:521`) journal the full numeric status. The replay path serves both `events.push` and the shipper pull (`ingestJournalEntries`, `:88` and `:108`), and it collapses the other statuses.
- **Scenario:** at the venue a runner is DQ'd (5), is over the maximum time (6), is out of competition (15), or runs in a no-timing class (2). The venue row is correct, but the cloud copy says Unknown with a finish time. Anything served from the cloud (public results, an Eventor upload from the cloud) then shows that runner as OK (see RES-21) or unplaced.
- **Fix (S):** use `valueToRunnerStatus(status)`. Add cases for statuses 2, 5, 6 and 15 to `__tests__/integration/events-push.test.ts`.
- **Verdict:** confirmed (proven from code).

### RES-08 Backup-memory punches are stored as clock time in the ZeroTime-relative column
- **Area / category:** time conversion, readout; functional.
- **Location:**
  - Client: `packages/web/src/pages/ControlsPage.tsx:1678` sends `punchTimeSecs * 10`.
  - `packages/api/src/routers/control.ts:1870` stores it raw, although the doc comment at `:1815-1820` says the column is relative.
  - `control.ts:1723-1727` compares it with relative times.
  - `control.ts:1805` and `:1890-1893` journal `toAbsolute` of an already-absolute value.
  - `packages/api/src/routers/cardReadout.ts:188-195` loads every punch for the card with no `source` filter.
  - Every other writer converts the time (`cardReadout.ts:1325`, `events.ts:593` and `:621`, `online-input/puller.ts:253`).
- **What is wrong:** an imported backup punch enters the readout matcher at its time plus ZeroTime. No push is needed for that. A pushed punch is present twice, as the backup row and its manual mirror (`control.ts:1780-1797`).
- **Scenario:**
  - A runner's card lacks control 45, and the organiser imports the unit's backup to rescue the result.
    - Control 45 now matches at +9 h, at the end of the punch list.
    - The greedy cursor (`shared/src/readout.ts:343-378`) then reports every later control as missing, so the rescue makes the MP worse.
  - Backup punches after 15:00 wrap to early morning and sort first.
  - For start and finish units, the backup page always shows `time_mismatch`.
  - Peers receive the wrong times through the journal.
  - A complete card only gains a harmless extra punch, so ordinary readouts keep the right status.
- **Fix (S–M):**
  - Store `toRelative(p.punchTime, zeroTime)`, and journal the absolute value directly.
  - Add a one-off repair script for existing `source = 'backup_memory'` rows.
  - Filter un-pushed backup rows out of `performReadout`, the Eventor export and the LiveResults radio query.
  - Integration test: import, push, read out, and the status is OK.
- **Verdict:** confirmed (proven from code). The verifier corrected the scenario: it is worse than first claimed for rescues, and harmless for complete cards.

### RES-09 `draw.execute` is not atomic, has no concurrency guard, and uses one transaction per runner
- **Area / category:** draw; stability, performance.
- **Location:**
  - `packages/api/src/routers/drawRouter.ts:158-199`.
  - The lease is checked once, in the `raceProcedure` middleware (`packages/api/src/trpc.ts:176-180`).
  - `docker/nginx.conf:24`: `proxy_read_timeout 120s`.
- **What is wrong:** each runner gets its own `$transaction` (update plus journal row), awaited one after another, then one transaction per class. Nothing locks out a second execute. Because `execute` re-randomises (RES-15), a retry produces a different draw rather than finishing the first one.
- **Scenario:**
  - A DB error or API restart during the loop leaves part of the event on the new draw and part on the old.
  - With 1,800 runners and a remote DB, the request can pass the 120 s proxy timeout. The server keeps writing, but the UI shows an error. The organiser presses Apply again, and the two loops interleave different random orders, leaving duplicate slots and gaps within a class.
- **Fix (M):**
  - Run the whole draw in one `$transaction` with a raised timeout, taking `pg_advisory_xact_lock(eventId)` first.
  - Update runners with a single `UPDATE … FROM (VALUES …)` and write the journal with `createMany`.
  - Integration test: an injected failure at runner N leaves zero rows changed.
- **Verdict:** confirmed (proven from code). The 2,000-runner timing was not measured. A proxy timeout alone does not half-apply the draw; that needs a crash or a DB error.

### RES-10 First-control spacing silently fails when classes sharing a first control have different intervals
- **Area / category:** draw; functional.
- **Location:**
  - `packages/api/src/draw/optimizer.ts:409`: `maxSteps = scheduled.length + (booked?.length ?? 0) + 2`.
  - The loop at `:410-432` places the class even when the last `firstControlShift` (`:126-149`) failed.
  - The only warning is `drawEngine.ts:210-219`, for a class's own interval.
- **Scenario:** two classes with the same first control, a 1:00 gap and 2 corridors. Every case below ends with two runners from different classes sent to the same control in the same second, with no warning. All of the inputs can be set in `DrawPanel`.

  | Class A | Class B | Pairs closer than the gap | Minimum gap |
  |---|---|---|---|
  | 30 × 3:00 | 30 × 2:00 | 10 | 0 |
  | 40 × 2:00 | 40 × 1:30 | 18 | 0 |
  | 60 × 3:00 | 20 × 2:00 | 7 | 0 |

  Equal intervals work.
- **Fix (S–M):** when a shift fails, jump straight past the last booked slot plus the gap, or loop with a bound proportional to booked × runners. A bound of 100,000 cleared every case. Have the optimizer return unresolved conflicts as warnings, and add the mixed-interval case to `optimizer.test.ts`.
- **Verdict:** confirmed (reproduced independently by reviewer and verifier).

### RES-11 The result list does not share places on ties, and disagrees with the receipt and Eventor
- **Area / category:** results, ranking; functional, engineering.
- **Location:**
  - `packages/api/src/routers/lists.ts:92-97`: `findMany` with no `orderBy`.
  - `lists.ts:181-200`: `entry.place++` at `:200`; classless key at `:192`; `runningTime > 0` at `:194`.
  - The tested `computeClassPlacements` (`packages/shared/src/results.ts:100`, ties at `:126-135`) is used only by the Eventor upload.
  - The receipt uses raw SQL in `routers/race.ts:240-254`.
  - `packages/web/src/pages/ResultsPage.tsx:53-61` sorts by the server's place, and the badge code at `:101`, `:165` and `:168` never runs.
- **What is wrong:**
  - Equal times get places 1 and 2, in Postgres row order, which can flip between refreshes. The Eventor upload gives 1, 1, 3, and the receipt gives both rank 1.
  - The list ignores `Class.noTiming`, so it ranks no-timing classes that the upload leaves unplaced.
  - The receipt ignores the no-timing-leg adjustment.
  - Classless runners are ranked together as one class.
  - The "unofficial" badge never shows.
- **Scenario:** two runners in H21 at 45:12. The results page and the speaker show one as 1st and one as 2nd, Eventor shows both 1st, and each runner's receipt says 1st. On the next refresh the 1st and 2nd may swap.
- **Fix (S–M):** build the result list per class with `computeClassPlacements`, passing `class.noTiming` and setting `entry.noTiming`. Add a stable `orderBy`. Make the receipt rank come from the same function. Add an integration test for `lists.resultList` covering ties, a no-timing class, DQ, a missing class and a start before ZeroTime.
- **Verdict:** confirmed (proven from code).

### RES-12 Finish station: the online and offline paths give different results
- **Area / category:** status handling, results; functional.
- **Location:**
  - `packages/web/src/pages/FinishStation.tsx:224-227` sends only `runnerId` and `finishTime`.
  - `packages/api/src/routers/race.ts:320-362` writes a status only if one is supplied; its response (`:364-388`) comes from `performReadout`.
  - The offline replay at `routers/events.ts:352-365` (`resolveRunner` at `:282-310`).
  - The test `__tests__/integration/events-push.test.ts:116-125` asserts the offline behaviour.
- **What is wrong:**
  - Online: the runner keeps Unknown with a finish time, so they never appear in the result list. The station shows "finished" with DNF and time 0, because `performReadout` takes the finish only from punches.
  - Offline: `finish.recorded` sets OK whenever the stored finish is 0, even over DNS or DQ.
  - The online path is last-write-wins on the finish time; the offline path is first-write-wins.
- **Scenario:** the same button press at the finish gives an OK result or no result depending on whether Wi-Fi was up, and offline it can turn a DQ runner into OK.
- **Fix (M):** put one shared function behind both paths: store the finish, set OK only from Unknown with a start time, and never touch DQ, DNS or Cancel. Make `performReadout` fall back to `runner.finishTime`. Update the test.
- **Verdict:** confirmed (proven from code).

### RES-13 Time input parses "HH:MM" as minutes:seconds, and the runner editor saves half-typed values
- **Area / category:** time input; functional.
- **Location:**
  - `packages/shared/src/types.ts:278-287` (`parseMeosTime`).
  - `packages/web/src/components/RunnerInlineDetail.tsx:78-96` (a 600 ms debounce), `:175`, `:181` and `:382-393`.
  - `RegistrationDialog.tsx:624` and `:647`.
  - `DrawPanel.tsx:49-51`, `:175`, `:182`, `:339-348` and `:537`.
  - `drawRouter.ts:14` accepts `interval` 0 for every draw method.
- **What is wrong:**
  - `parseMeosTime` reads `"10:30"` as 00:10:30. Input with one part, or empty, becomes 0.
  - The runner editor saves 600 ms after every keystroke, with no blur or Enter commit and no validation, and the saved value is journaled (`runner.ts:681-686`).
- **Scenario:**
  - An operator correcting a finish time pauses after typing "1", and the time is cleared (0). They pause at "10:4", and 00:10:04 is saved and journaled. They type "10:30" and stop, and 00:10:30 stays stored.
  - In the draw panel, an interval of "2" or an empty interval gives the whole class one start time, and a first start of "10:00" becomes 00:10:00. Here the preview at least shows the result before Apply.
- **Fix (S–M):**
  - Add a strict `parseClockTime` for clock fields: `H:MM` or `H:MM:SS`, returning null when invalid.
  - Add a separate duration parser that accepts bare minutes.
  - Save the runner editor's times on blur or Enter, and only when valid.
  - Require `interval >= 1` unless the method is simultaneous.
  - Add unit tests for both parsers.
- **Verdict:** confirmed (reproduced). `"10:30"` → 6300, `"10:4"` → 6040, and `"2"`, `""` and `"abc"` → 0.

### RES-14 Each LiveResults sync cycle deletes in-forest runners, runs fully sequentially, and can overlap itself
- **Area / category:** results exposure; performance, stability.
- **Location:**
  - `packages/api/src/liveresults.ts:401-415`: delete of every Unknown-status runner.
  - `:417-503`: one awaited statement at a time, with no transaction.
  - `:475`: a Postgres punch query per runner.
  - `:591`: `setInterval` with no in-flight guard; `pushNow` at `:610` can also overlap.
  - The interval is 30 s by default, 5 s minimum (`routers/liveresults.ts:36` and `:110`). The pool allows 5 connections.
- **What is wrong:** every cycle deletes the rows of all Unknown runners (everyone in the forest, and finishers not yet read out), then re-inserts them with 2–3 remote statements each, plus one per radio punch.
- **Scenario:** 2,000 runners is about 4,000+ round trips to the remote MySQL per cycle. Over a WAN, that can exceed the 30 s interval, so cycles queue behind each other. Even without overlap, every in-forest runner and their radio splits drop off the public page between the delete and their own re-insert in each cycle, and `changed` is reset each time.
- **Fix (M):** delete only the rows of runners who lost their start or result; batch the writes with multi-row `INSERT … ON DUPLICATE KEY UPDATE`; load punches once per cycle; skip a tick while one is still running; push only rows changed since the last cycle; add a test for `syncAll`.
- **Verdict:** the mechanics are confirmed from code. "Mostly missing at 2,000 runners" is plausible; the sync duration was not measured.

## Medium

### RES-15 The applied draw is not the previewed draw
- **Area / category:** draw; functional.
- **Location:** `packages/api/src/routers/drawRouter.ts:133-138` calls `generateDrawPreview` again; `packages/api/src/draw/algorithms.ts:23` and `:143` use an unseeded `Math.random`; `DrawPanel.tsx:260-263` sends only the settings.
- **Scenario:** the organiser checks the runner order in the preview, presses Apply, and gets a different order in every random, club-separated and seeded class. The class blocks only stay the same if no entries changed in between.
- **Fix (M):** have the preview return a seed and a hash of the runner set, and have the algorithms take an injected seeded PRNG. `execute` requires the seed, and refuses with "preview is stale" if the runner set has changed. This also makes the algorithms deterministic to test.
- **Verdict:** confirmed (proven from code).

### RES-16 Events that cross midnight get MP or no time, and the draw does not warn when it runs past 24:00
- **Area / category:** time conversion; functional.
- **Location:**
  - `packages/api/src/timeConvert.ts:24-27` wraps into 0..24 h.
  - Sorting and subtraction on wrapped values happen at `cardReadout.ts:227-229` and `:252-254`, `lists.ts:172-175`, `race.ts:116-121`, `routers/eventor.ts:1612-1627` and `eventor.ts:1420-1423`.
  - `readout.ts:318-319` takes the first start or finish punch from the sorted list.
  - In the draw, `drawEngine.ts:221` and `:260-266` have no day-boundary check.
  - `StartScreenPage.tsx:153-159` sorts by absolute time.
  - `drawRouter.ts:178` journals the unwrapped value.
- **Scenario:**
  - A runner starts at 23:30 and punches controls both before and after midnight. The punches after midnight sort first, the rest go missing, and the runner gets MP.
  - If all punches are after midnight, the running time is clamped to 0 and the status does not change.
  - A deep draw (60 classes on 4 shared first controls, reproduced at +748 min) that starts at 12:00 runs past midnight with no warning. The start screen then lists those runners first.
- **Fix (M):** do all ordering and arithmetic on relative (monotonic) times, and wrap only for display. In the draw, warn when any start reaches 24:00 and block Apply. Add tests for durations across midnight.
- **Verdict:** confirmed (reproduced). The reviewer got missing count 1, a raw time of −834000 and status 3 for a clean night run. Only events past 00:00 are affected.

### RES-17 Start numbers restart at 1 on every draw, and the draw does not journal them
- **Area / category:** draw, sync; functional.
- **Location:**
  - `packages/api/src/draw/drawEngine.ts:227`, `:265` and `:278`.
  - `schema.prisma:780` has no unique constraint on start number.
  - The `start.adjusted` payload at `drawRouter.ts:175-179` carries no start number, and its replay at `events.ts:430-443` writes only `startTime`.
  - The bib fallback is at `liveresults.ts:425`.
- **Scenario:**
  - The organiser draws every class (numbers 1 to 800), then redraws H21 alone, which gets 1 to 40 again, duplicating D10's numbers on lists and on LiveResults, where the start number stands in for an empty bib.
  - Peers that replay the journal keep the old start numbers, so the start-list order (sorted by start number) differs between nodes.
  - A manual `runner.update` does journal the start number; only the draw path leaves it out.
- **Fix (S–M):** start numbering at one more than the highest start number outside the drawn classes. Add `startNo` to `start.adjusted` and its replay, with tests.
- **Verdict:** confirmed (proven from code).

### RES-18 Club separation leaves clubmates back to back in small classes
- **Area / category:** draw; functional (fairness).
- **Location:** `packages/api/src/draw/algorithms.ts:163-210`; the condition is at `:177-187`.
- **What is wrong:** for an adjacent swap candidate, the check compares a runner with itself. It also tests neighbours before the swap, so a legal swap is always rejected.
- **Scenario:** share of 20,000 draws with clubmates back to back. A separated order exists in every case.

  | Club sizes | Back to back |
  |---|---|
  | [2,2] | 50% |
  | [3,3] | 75% |
  | [3,1,1] | 75% |
  | [3,2,1] | 50% |
  | [2,1,1] | 24% |

  Classes of 25 or more mixed runners are fine.
- **Fix (S–M):** evaluate each swap on the array after the swap (swap, count adjacencies, revert if not better), or build the order constructively. Add a property test: when the largest club is at most ceil(n/2), no neighbours share a club. `algorithms.ts` has no unit test at all.
- **Verdict:** confirmed (reproduced by both reviewer and verifier).

### RES-19 Seeded draw: the club-separation pass moves top seeds, and ranking scores are rounded to integers
- **Area / category:** draw; functional.
- **Location:**
  - `packages/api/src/draw/algorithms.ts:96-123` and `:152-157`.
  - `drawEngine.ts:248` always passes `clubSeparation: true`.
  - `routers/eventor.ts:810`, `:1078` and `:1135` apply `Math.round` to the score; `eventor.ts:780` parses it as a float, and `schema.prisma:813` stores it as an `Int`.
  - The comment at `algorithms.ts:111` contradicts the sort direction.
- **Scenario:**
  - 20 seeded runners from 4 clubs, clustered by rank. The second seed moves from slot 19 to slot 12, and rank 17 starts second to last.
  - With scattered clubs, seeds move only 1–3 places.
  - A score between 0 and 0.5 becomes rank 0, which means unseeded, so that runner starts early.
- **Fix (M):**
  - Settle the rank direction first (whether a lower Eventor score is better). This was not verified.
  - Limit separation swaps for seeded runners to adjacent positions.
  - Store the score unrounded or scaled.
  - Fix the comment.
- **Verdict:** displacement and rounding are confirmed (reproduced and from code). The real-world impact is plausible, since it depends on the shape of the ranking list.

### RES-20 Offline readout never applies no-timing or max time, and ranks MP/DQ runners
- **Area / category:** offline results; functional.
- **Location:**
  - `packages/web/src/lib/offline/local-readout.ts:93-94` and `:215-216` test `cls?.noTiming === 1`, but `ClassInfo.noTiming` is a boolean (`shared/src/types.ts:383`, sent at `event.ts:489`), and no `maxTime` is sent. The local `ClassItem` type at `:343-351` hides the mismatch.
  - `local-readout.ts:100-107` and `:246-253` call `computePosition` without a status.
  - `findCachedQuery` (`:320-331`) uses the first cached `runner.list`.
- **Scenario:** during an outage, a runner in a no-timing youth class reads out as OK. That status is journaled and the server stores it, so the runner is ranked with a time. An over-time runner also becomes OK. The offline receipt can say "3rd" behind two MP runners.
- **Fix (S–M):** test `cls?.noTiming === true`; add `maxTime` to `ClassInfo` and the dashboard payload; filter the position input to OK runners; choose the unfiltered runner list in `findCachedQuery`. Add cases to `packages/web/src/lib/__tests__/local-readout.test.ts`.
- **Verdict:** the no-timing/max-time and rank parts are confirmed from code. The `findCachedQuery` part is plausible: it only bites if a search query was cached before the full list.

### RES-21 The Eventor result upload reports Unknown runners as DNS or OK, and skips splits when `cardId` is not set
- **Area / category:** results exposure; functional.
- **Location:**
  - `packages/api/src/eventor.ts:352-366`: the default at `:364`, and a dead ternary at `:360` where both branches are "NotCompeting".
  - `eventor.ts:1421-1425`.
  - `routers/eventor.ts:1559-1561` and `:1675` upload every non-removed runner; `:1612` looks up the card by `cardId` only; `:1748` sends classless runners as "Unknown".
- **Scenario:** a results upload mid-event marks everyone still in the forest as DidNotStart. Unknown runners who have a finish time go up as OK with no Time or Position. Runners whose `cardId` was never set (it is only written on readout) are uploaded without splits or the no-timing-leg adjustment.
- **Fix (S):** map Unknown to the IOF 3.0 statuses `Active`, `Inactive` or `Finished`; fall back to `cardNo` as `lists.ts:157` does; remove the dead ternary.
- **Verdict:** confirmed (proven from code). How Eventor treats these statuses was not checked.

### RES-22 Cancelled and DNS runners appear on the start screen and in the Eventor start list
- **Area / category:** start lists; functional.
- **Location:**
  - `packages/api/src/routers/event.ts:721-725` filters only on `removed: false`, and `:754` hard-codes status 0, so the client (`StartScreenPage.tsx:37`) cannot filter either.
  - `routers/eventor.ts:1825-1827` and `:1839`.
  - `eventor.ts:1507`, `:1534-1538` and `:1574`.
- **Scenario:** a runner withdrawn after the draw keeps their start time, is called up on the big screen, and is uploaded to Eventor with it. Classless runners go up under a class named "Unknown" with no Id.
- **Fix (S):** filter out withdrawn runners (and DNS for the start screen) and `classId = null` in both places. Add tests.
- **Verdict:** confirmed (proven from code).

### RES-23 LiveResults content errors
- **Area / category:** results exposure; functional.
- **Location:** `packages/api/src/liveresults.ts`:
  - `:58` maps no-timing to status 0.
  - `:323-326` (the class select) has no `noTiming` field.
  - `:385` and `:401-403`: removed runners are never deleted remotely.
  - `:457-460` ignores the no-timing-leg adjustment.
  - `:471-472` takes radio controls from the class course; the runner select at `:386-398` does not fetch `courseId`.
  - `:449`, `:464` and `:495`: `changed` is not updated on a duplicate key.
- **Scenario:**
  - A no-timing class gets a public ranking.
  - A deleted entry stays on LiveResults forever.
  - The public time differs from the result list on a course with a no-timing leg.
  - Runners on forked variants get the wrong radio splits.
- **Fix (M, together with RES-14):** push no time for no-timing runners, delete the remote rows of removed runners, reuse the result-list computation, use the runner's variant course, and set `changed` on update.
- **Verdict:** confirmed from code. The effect of `changed` on the LiveResults side is plausible (that site was not contacted).

### RES-24 Status input is not validated, and a kiosk key can set any status
- **Area / category:** status handling; security, functional.
- **Location:**
  - `packages/api/src/routers/cardReadout.ts:809` and `routers/race.ts:327` accept `z.number().int()`.
  - `statusConvert.ts:49-51` maps unknown values to Unknown.
  - `recordFinish` is `kioskOrRaceOperateRaceProcedure` (`trpc.ts:341`).
- **Scenario:** a device holding only a kiosk key can set any status and finish time on any runner by seq, for example DQ, or OK over MP. A client bug that sends an unknown number silently clears the status.
- **Fix (S):** validate the status against the `RunnerStatusValue` enum. For kiosk callers, restrict `recordFinish` to setting a finish time without a status.
- **Verdict:** confirmed (proven from code). Whether `performReadout` afterwards overrides a status set from a kiosk was not traced.

### RES-25 "Finished" and "in forest" are defined three ways
- **Area / category:** status handling; engineering, functional.
- **Location:**
  - `packages/api/src/routers/runner.ts:372-378`: statuses 1, 3, 4, 5 and 6.
  - `isFinished` in `packages/shared/src/types.ts:98-104`, used by the dashboard at `event.ts:440` and `:436-446`.
  - `packages/web/src/lib/structured-search/anchors/runner-anchors.ts:97-110`.
  - The dashboard links to the list at `CompetitionDashboard.tsx:143`.
- **Scenario:** the dashboard's "in forest" count (based on the clock and punches) links to `status:in-forest`. That list shows every drawn runner without a result, even those not yet due to start. The two numbers never match during the end-of-day missing-runner check. The server filter is unused by the web client.
- **Fix (S):** one shared `isFinished` and `hasStarted(rel, now)` in `shared`, used by the dashboard, the anchors and the server. Delete the unused server variant.
- **Verdict:** confirmed (proven from code), with the effect corrected by the verifier as described.

### RES-26 Cards page: the "current readout" shows no control codes and no start, finish or check
- **Area / category:** readout display; functional.
- **Location:**
  - `packages/api/src/routers/cardReadout.ts:1125-1127` reads `{type, time}`.
  - The writers (`:521`, `:1457`) store `{controlCode, time}`.
  - The header times exist only in `cards.punches_raw` (`:540-548`).
  - The page is `CardsPage.tsx:673-730`.
- **Scenario:** every card's detail shows blank codes and no start, finish or check rows. The history section below it is correct.
- **Fix (S):** read `controlCode`, and take the start, finish and check times from `cards.punches_raw` (or store them in `card_readouts`). Add a test for `cardDetail`.
- **Verdict:** confirmed (proven from code). This overlaps the SI-readout area review.

### RES-27 Tests are thin where it matters, and some cannot fail
- **Area / category:** tests.
- **Location and gaps** (all confirmed):
  - `packages/api/src/draw/algorithms.ts` has no unit test, although `__tests__/integration/draw.test.ts:6-7` says the unit suite covers it.
  - `draw.test.ts:165-168` only asserts `startTime > 0`, with a first start of 10:00. The test at `:386-415` does assert exact persisted times.
  - `e2e/draw.spec.ts:47-67` passes as long as any cell matches a time pattern, so a pre-seeded list satisfies it.
  - The header of `draw/__tests__/optimizer.test.ts:13-14` contradicts the test at `:206-222`.
  - No test calls `lists.resultList`, or `syncAll`, `statusConvert` (round trip), `control.importBackupPunches` or `cardDetail`.
  - `timeConvert.test.ts` has no case at `absolute == zeroTime` and none for durations across midnight.
  - `events-push.test.ts` only asserts status OK.
- **Fix (M):** add the tests named in each finding above, and correct the two misleading comments.

### RES-28 The readout docs describe write guards that do not exist
- **Area / category:** engineering (docs).
- **Location:**
  - `docs/system/registration-and-readout.md`: lines 163, 245-298 (oCard written "only if strict guards pass", ReadId dedupe), 555-577 ("three layers… must pass all applicable checks") and 829-834. §5b and §10 also describe the retired MeOS layout.
  - `docs/guide/race-day.md:63`.
- **Scenario:** an organiser or a fixing session trusts the documented stale-punch protection, which RES-01 shows is not there.
- **Fix (M):** rewrite these sections against the current pipeline once RES-01 is decided.
- **Verdict:** confirmed (proven from code).

## Low

### RES-29 LiveResults competition credentials are predictable, and `tavid` allocation races
- **Location:** `packages/api/src/liveresults.ts:235-250`.
- **What is wrong:** the user is md5("oxygen") and the password is md5("oxygen_<eventId>"). `MAX(tavid)+1` followed by an INSERT has no lock. If `event.update` (`:252`) fails, an orphan login row is left behind.
- **Severity note:** low, because the upload itself already uses the shared hard-coded key `liveemmaclient` (`:37-38`).
- **Fix (S):** generate a random secret per event and store it encrypted; retry on a duplicate `tavid`.
- **Verdict:** confirmed from code. The impact is plausible: what the login gates on the LiveResults side was not checked.

### RES-30 A class with a fixed first start skips the same-course check; a negative `corridorHint` is accepted
- **Location:** `packages/api/src/draw/optimizer.ts:310-313`, `:366-379` and `:250`; `drawRouter.ts:15-16`.
- **Scenario:** an API caller pins one class and leaves another on the same course on auto. They get the same start, or are interleaved a minute apart. A negative hint gives corridor −1, which the UI shows as "fixed". The web UI cannot trigger either.
- **Fix (S):** include fixed classes in the conflict graph, and add `.min(0)` to the corridor hint.
- **Verdict:** confirmed (reproduced). The verifier found no NaN reaches the output.

### RES-31 Class detail shows the stored relative first start as a clock time
- **Location:** `packages/api/src/routers/classRouter.ts:90` (and raw writes at `:217`, `:329` and `:376`); `packages/web/src/pages/ClassesPage.tsx:919-920`.
- **Scenario:** a 10:00 draw with ZeroTime 09:00 shows "First start 01:00:00". The write side is latent, since no web caller sends `firstStart`.
- **Fix (S):** apply `toAbsolute` and `toRelative` as `drawRouter.ts:71` and `:192` do.
- **Verdict:** confirmed (reproduced).

### RES-32 The draw stores a stale interval for a mass start, and counts runners by loading every row
- **Location:** `drawRouter.ts:193` and `:49-61`; `drawEngine.ts:165-171`.
- **What is wrong:** a mass-start class is stored with the disabled UI interval (by default 1200 ds) while 0 was used. `draw.defaults` uses `findMany` where `groupBy` would do. Club name-hash keys can collide.
- **Fix (S):** store 0 for a simultaneous start, use `groupBy`, and key clubs on the normalised name.
- **Verdict:** confirmed (proven from code); each is minor.

### RES-33 Dead code and unused schema
- **Location:**
  - `packages/api/src/routers/external.ts` is mounted but has no caller. It is behind `viewProcedure`, although its header says it "may not authenticate".
  - These schema fields have no readers: `Team` (`schema.prisma:852`), `Class.legMethod` (`:722`), `Event.numStages` (`:167`), and `Runner.inputTime`, `multiResults` and `timeAdjust` (`:806`, `:811`, `:815`).
  - A `startTime <= 1` sentinel at `lists.ts:71`, `event.ts:439` and `runner.ts:370` has no writer.
- **Fix (S):** remove `external.ts`, or fix its header. Mark the columns as legacy (they mirror MeOS) or drop them in a migration. Drop the `<= 1` sentinel.
- **Verdict:** confirmed by grep. The `<= 1` sentinel is plausible only, since imported values cannot be ruled out.

### RES-34 `encodePunchesRaw` mis-encodes negative times that have tenths
- **Location:** `packages/api/src/routers/cardReadout.ts:480-491`.
- **Scenario:** −6005 encodes as `31--601.-5` and parses back as −6015. It only bites for punches before ZeroTime that have non-zero tenths.
- **Fix (S):** encode with the sign separated from the absolute value, and add a round-trip test.
- **Verdict:** confirmed (reproduced).

### RES-35 `addPunch` resolves the control by substring
- **Location:** `packages/api/src/routers/cardReadout.ts:1307-1313`.
- **Scenario:** code 3 matches a control whose codes are "31" or "130", so the wrong `Punch.controlId` is stored. Matching uses `controlCode`, so results are not affected.
- **Fix (S):** match exact elements of the split code list.
- **Verdict:** confirmed (proven from code).

---

## Reviewed and found clean
- `statusConvert.ts`: all 11 enum values map both ways. It only lacks a round-trip test (RES-27).
- `serverClock.ts`: no issue.
- Competition scoping in the `lists`, `race`, `runner`, `cardReadout`, `liveresults` and `draw` routers and the start-list push: every query is bound to `ctx.event.id`, and draw execute requires `event.manage` plus the lease. No cross-competition leak was found.
- DST: there is no date-based arithmetic, so nothing is DST-specific beyond the time-zone issue in RES-06.
- `matchPunchesToCourse` and `computeClassPlacements` are correct for inputs within one day.
- The optimizer terminates and is fast (8 ms for 2,040 runners). Interval 0 and single-runner classes are handled. `randomDraw` is a correct Fisher–Yates, and no algorithm loses or duplicates a runner.
- `StartScreenPage.tsx` minute grouping and call-up arithmetic, and the drag and drop in `DrawTimeline.tsx`.
- PR 254: in this area it only adds `<Course>` to the Eventor start-list and result uploads, with tests. It inherits RES-05, RES-21 and RES-22 and adds nothing new.

## Not reviewed, or could not be verified
- No database, integration or E2E run was possible (`pnpm install` failed in the container). RES-02, RES-03, RES-07, RES-08, RES-09, RES-11, RES-12 and RES-17 are proven from code only.
- RES-06 was not run in a container. The timings for RES-09 and RES-14 at 2,000 runners were not measured.
- Not contacted: LiveResults (`changed` semantics, `tavid` uniqueness, what the login gates) and Eventor (status values, the "Unknown" class, the meaning of the ranking score).
- Not verified, and so left out: the draw timeline drawing class blocks with a different width from the optimizer (`draw-timeline.ts:38-40` against `optimizer.ts:173-176`).
- Not read: `KioskPage.tsx` beyond its clock, `testLab.ts`, `scripts/migrate-mysql-to-pg.ts` (where ZeroTime comes from for migrated events), the sync shipper and lease, the draw for forked variants with different first controls, and the i18n strings. `event.ts`, `runner.ts`, `race.ts` and `classRouter.ts` were read only for their time, status and start parts.

# Review area 05: SI card readout and the Bluetooth reader

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Reviewed on `main` at `df5460c3`. PR #254 (`claude/project-thread-avzbks`) does not touch this area.

**Scope.** Everything a card goes through from the reader to a stored result:

- USB/serial transport: `packages/web/src/lib/webserial.ts`, `si-protocol.ts` (all card types, frames, CRC, station backup), `si-reader.ts`, `reader-hub.ts`
- Bluetooth reader: `packages/web/src/lib/reader-bt/*`
- Client pipeline: `packages/web/src/context/DeviceManager.tsx`, `lib/offline/local-readout.ts`, `lib/offline/card-read-payload.ts`
- Pages: `CardReadout.tsx`, `KioskPage.tsx`, `FinishStation.tsx`, `BackupPunchesPage.tsx`, `CardsPage.tsx`, `CardNotification.tsx`, `RecentCards.tsx`, `ReaderConnectionDialog.tsx`
- Server: `packages/api/src/routers/cardReadout.ts`, the readout parts of `routers/events.ts` and `routers/race.ts`, `statusConvert.ts`, `timeConvert.ts`, `packages/shared/src/readout.ts`
- Hire cards wherever they are handled

**Method.** Two Fable reviewers each read half of the area in full. One took transport, protocol and Bluetooth; the other took processing, matching, persistence and hire cards. Each finding then went to its own fresh Fable verifier, which saw only the location and the claim and was asked to disprove it. That made 35 verifiers. They read the code, and where it was cheap they reproduced the problem with scratch scripts against the real functions and the repo's own SPORTident capture (`lib/__tests__/fixtures/readout-backup-pcap.ts`, ground truth in `docs/si-protocol/readout-backup/readouts.txt`). No finding was refuted outright. One scenario inside SI-17 was refuted and dropped, and several severities were changed after verification; each finding says where.

Paths are relative to the repo root. `web/` means `packages/web/src/`, and `api/` means `packages/api/src/`.

## Summary

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 8 |
| Medium | 21 |
| Low | 17 |

**Fix first**

1. **SI-01**: a re-read of a card overwrites the stored result. A cleared hire card turns OK into DNF, and a re-read after a jury DQ brings the runner back as OK.
2. **SI-02** and **SI-03**: while the server is unreachable, readout results are never queued. On a standalone kiosk nothing at all is queued, but the runner is still shown a result.
3. **SI-04**: SI8, SI9 and pCard punches are read from the wrong offset. This was reproduced on the repo's own capture: an SI8 card with owner data gives six garbage punches and loses the real ones.
4. **SI-05**: a USB readout cut short (card pulled early) is stored and beeped as complete, which gives MP with an OK beep.
5. **SI-07**: `events.push` applies result, runner and course entries for any signed-in user, with no capability check.

Several findings share one root cause: there is no single server-side "apply a readout" step (SI-02, SI-10, SI-11, SI-15). A fix session should take SI-01, SI-02, SI-10 and SI-11 together and build one shared server helper (store, then evaluate, then apply under the SI-01 guards) that is used by `storeReadout`, the `card.read` ingest and `pushReadoutBackup`.

---

## Critical

### SI-01 A re-read overwrites the stored result: a cleared card wipes an OK result, and a re-read undoes a DQ
- **Area:** readout processing. **Category:** functional / data loss. **Severity:** critical
- **Location:** `api/routers/cardReadout.ts:556-580` (unconditional `punchesRaw` overwrite, line 566), `:805-855` (`applyResult` writes status/start/finish unconditionally; selects `runner.status` at :823 and never uses it); `web/context/DeviceManager.tsx:451-466, 503-510`; `packages/shared/src/readout.ts:548-561`
- **What is wrong:** `storeReadoutImpl` always replaces the Card row's punches with whatever was just read. DeviceManager chooses action "readout" whenever `punchesRelevant || hasDbResult`, and then always calls `applyResult` with the freshly computed status. `computeStatus` keeps `currentStatus` only when it cannot decide. The guards described in `docs/system/registration-and-readout.md` §3d–§3f (`shouldWriteOCard`, `punchesFresh`, ReadId dedup) do not exist: `punchesFresh` is accepted and journaled but never read, and `computeReadId` has no production caller. The client dedup only skips `storeReadout`; the resolve/apply block runs "always — even for duplicates" (:433), so an identical re-read re-applies too.
- **Scenarios:**
  1. A runner finished OK. The hire card is collected, cleared, and inserted again to tick it off as returned. Empty punches give `punchesRaw ""`, so `performReadout` finds no finish and returns DNF. `hasDbResult` is true, so `applyResult` writes `status=dnf, finishTime=0`. The result is gone from the runner row.
  2. The jury sets a runner to DQ, and the runner re-inserts the card at the kiosk for a printout. The status goes back to OK and the runner is in the results again. Manually corrected start or finish times are overwritten the same way.
- **Fix (M):** do this on the server, because offline clients compute results too. In `storeReadoutImpl`, do not replace `punchesRaw` with a read that has no punches and no finish while the existing row has a finish, and honour `punchesFresh === false`. In `applyResult`, and in the `result.applied` ingest at `api/routers/events.ts:391`, refuse to overwrite `dq`, `not_competing` and other manually set statuses, and refuse to replace a non-zero finish with DNF and finish 0, unless `force: true` is passed. Return "result kept, card differs" so the operator sees it. Add integration tests for both scenarios and bring §3 of the doc in line with the code.
- **Verified:** confirmed from code (verifier traced both scenarios; recovery is only by hand from `card_readouts` and the journal).

### SI-02 An offline or failed-fetch readout never queues `result.applied` (stale closure)
- **Area:** client pipeline / offline. **Category:** stability. **Severity:** critical
- **Location:** `web/context/DeviceManager.tsx:572-573` (state declared :252; `useCallback` deps `[]` at :604-605 under an eslint-disable)
- **What is wrong:** `addRecentCard` closes over the first render's `competitionNameId` state, which is `null` for good. The local-compute branch tests `if (competitionNameId)` before `emitEvent("result.applied", …)`, so the emit never runs. Every other emit in the function uses `competitionNameIdRef.current`.
- **Scenario:** the arena network is down and a runner reads out. `card.read` is queued (:418-426) and the kiosk shows "OK 34:12", but `result.applied` is not queued. When the outbox drains, the server's `card.read` ingest (`api/routers/events.ts:731-795`) only calls `storeReadoutImpl`, which never writes status or finish. Every runner read during the outage ends with a stored card and no result, and nothing on screen says so. There is no bulk re-evaluate path; each card has to be read again online.
- **Fix (S):** use `competitionNameIdRef.current` at :572-573, and add a test that an offline readout queues both `card.read` and `result.applied`. The more robust fix is to have the server apply the result when it ingests `card.read` (see the shared helper in the summary), under the SI-01 guards.
- **Verified:** confirmed from code.

### SI-03 A standalone kiosk queues nothing when the server is unreachable
- **Area:** client pipeline / offline. **Category:** stability. **Severity:** critical (high if critical is reserved for unrecoverable loss: the punches stay on the card until it is cleared)
- **Location:** `web/App.tsx:95-97` (`/:nameId/kiosk` and `/:nameId/start-screen` are routed outside `CompetitionShell`); `web/pages/CompetitionShell.tsx:233, 258` (the only callers of `setCompetitionNameId`); `web/context/DeviceManager.tsx:410, 420` (`card.read` guards), `:520-521, :571-573` (`result.applied` guards)
- **What is wrong:** `competitionNameIdRef` is set only by `CompetitionShell`. `KioskPage` never sets it. In standalone kiosk mode the ref is `null`, so all four emit sites are skipped silently; the only trace is a `console.warn` that says "queuing offline event". The local path still computes a result from cache and the kiosk shows it (`KioskPage.tsx:319-341`). The same happens for a card read in the admin tab on `/` or `/settings`, because the shell's cleanup resets the ref to `null`.
- **Scenario:** a standalone kiosk tablet with its own reader loses Wi-Fi. A runner inserts a card, `storeReadout` throws, nothing is queued and a result screen is shown. The readout exists nowhere but on the card.
- **Fix (S):** derive the competition inside DeviceManager from the URL or route param, the same way `web/lib/trpc.ts:22-26` does, rather than calling a setter from KioskPage (an unmount cleanup would race with CompetitionShell's). When no competition can be resolved, show an operator-visible error instead of dropping the read. Confirm that the event queue is drained in kiosk mode: `drainEventQueue` is only mounted through `hooks/useEventQueue.ts`, which KioskPage may not use.
- **Verified:** confirmed from code.

---

## High

### SI-04 SI8, SI9 and pCard punches are read from the wrong card offset
- **Area:** SI protocol. **Category:** functional. **Severity:** high (top of the band; every SI8 runner with owner data, and every SI8 with up to 24 punches read live, gets wrong punches)
- **Location:** `web/lib/si-protocol.ts:821-878` (`parseSI8CardData`, `startOffset = bi === 0 ? 32 : 0` at :850; the loop runs until `punches.length === punchCount` at :848, :855); `web/lib/webserial.ts:606-619` (block 1 is requested only when `punchCount > 24`)
- **What is wrong:** the parser assumes punches start at block 0 byte 32. On real cards that area is owner data, and punches start at byte 136 for SI8, byte 56 for SI9 and byte 176 for pCard. The parser only works when the owner area happens to be blank, because blank records are skipped.
- **Scenario (reproduced on the repo's capture):**
  - SI8 2220164 carries owner data "2220164;SPORTident Swede". Ground truth is 48, 56, 53, 41, 57, 44, 45, 31, 32, 100. With 2 blocks the parser returns `50@03:34:08 54@15:42:51 336@17:38:26 361@07:08:21 372@02:17:55 357@19:08:21 48 56 53 41`: six garbage punches decoded from ASCII, and the last six real punches lost. A live read fetches block 0 only (10 ≤ 24) and returns only the six garbage punches.
  - SI8 2164102 has no owner data and 27 punches. It decodes correctly only because 27 > 24 forces block 1. The same card with up to 24 punches would read as zero punches live.
  - pCard (all punches in block 1) always gives zero punches.
- **Why tests miss it:** `web/lib/__tests__/si-protocol.test.ts:830-975` and `e2e/helpers/mock-webserial.ts:72-147` build synthetic blocks with punches at offset 32. The capture-based test for card 7 asserts only `punchCount`. `docs/si-protocol/readout-backup-format.md:125-129` already notes the mismatch.
- **Fix (M):** add a per-series layout table keyed on the series byte `b0[24]`: SI9 (1) first punch 56, max 50; SI8 (2) 136, max 30; pCard (4) 176, max 20; tCard handled separately. Always read both blocks for these types (`BLOCKS_TO_READ` already says 2), concatenate them, and iterate by slot index `0..punchCount-1` (this also fixes SI-24). Replace the synthetic fixtures with assertions of the full punch lists for both SI8 cards in the capture against `readouts.txt`, fix the e2e mock, and correct `readout-backup-format.md:80-82, 125-129`.
- **Verified:** confirmed and reproduced for SI8. The SI9 (56) and pCard (176) offsets are plausible: they follow the published SPORTident layout, but the repo has no capture of those cards.

### SI-05 A timed-out or interrupted USB readout is stored as complete, with the OK beep
- **Area:** USB transport. **Category:** stability. **Severity:** high
- **Location:** `web/lib/webserial.ts:549-557` (the block timeout calls `finalizeReadout`), `:631-677` (`finalizeReadout` never compares `pendingBlocks.length` with `pendingTotalBlocks`; ACK at :671, dispatch at :673-675), `:481-487` (CARD_REMOVED does not cancel a pending read)
- **What is wrong:** when the next block does not arrive within 2 s, whatever arrived is parsed, ACKed (the station beeps OK) and dispatched as a normal `si:card-readout`. The parsers return fewer punches with no flag, and the server stores `punchCount: input.punches.length` (`api/routers/cardReadout.ts:678`), so the shortfall cannot be detected later.
- **Scenario:** an SIAC with 40 punches needs blocks 0–5. The runner pulls the card after block 4. Oxygen emits 32 of 40 punches with the finish time (from block 0), the match score is well above 0.2, and MP is written with an OK beep. If the card is pulled during blocks 1–3, the readout has zero punches and a finish time.
- **Fix (S–M):** in `finalizeReadout`, require `pendingBlocks.length === pendingTotalBlocks` before ACK and dispatch. Otherwise reset the state, `console.warn` the card number and the blocks received, and emit `si:card-read-failed`, which the kiosk and operator screen show as "insert the card again". CARD_REMOVED should abort the pending read at once. Optionally re-request a missing block once. As a second line of defence, DeviceManager should reject a readout whose `punches.length < punchCount` (this also covers Bluetooth). Add a unit test with a fake port (see SI-31).
- **Verified:** confirmed from code.

### SI-06 Station backup read: failed pages are skipped silently, replies are not matched to requests, and auto-clear can then erase the station
- **Area:** USB transport / backup recovery. **Category:** stability / data loss. **Severity:** high. The reviewer said medium; the verifier raised it because of auto-clear. Without auto-clear it is medium.
- **Location:** `web/lib/webserial.ts:1108-1151` (`_walkBackupPages`: skip at :1140-1144, unchecked push at :1146), `:1214-1226`, `:689-717` and `:749-758` (`sendAndWait`/`checkCommandResponse` match on the command byte only); `web/lib/si-protocol.ts:1763-1774`; `web/pages/ControlsPage.tsx:1621-1627, 1693-1699` (`clearBackupMemory()` after a "successful" read)
- **What is wrong:** a page that fails four attempts is dropped and the remaining pages are concatenated, so every later block shifts by 128 bytes. Multi-block slots then take the next card's block, and the walker emits bogus "SI5" records from personal-data blocks, because the SI5 branch accepts any chunk with non-zero bytes 4–6. A late reply to a timed-out attempt satisfies the next request, after which every page holds the previous page's data (one page duplicated, the last page lost). Nothing is reported to the caller, so the read returns `success: true`.
- **Scenario:** an operator recovers a readout station's backup after an outage, with "auto clear" on. One page times out four times. The upload gets shifted or garbled cards, and the station's backup flash, the last good copy, is then erased.
- **Fix (S–M):** check that the echoed address (`resp.data[2..4]`) equals the requested address and that the length is `5 + count`; on a mismatch, discard the reply and wait again (this also stops the late-reply cascade). An unrecoverable page should throw, or return `missingPages` so that ControlsPage reports failure. Never call `clearBackupMemory()` unless the read was complete. In readout mode, place each page by address in a pre-sized buffer filled with 0xEE instead of concatenating. Add an SI5 plausibility check (punch counter ≤ 36, series ≤ 4, number in the SI5 range).
- **Verified:** confirmed from code.

### SI-07 `events.push` applies result, runner and course entries for any signed-in user, with no capability check
- **Area:** readout write path / auth (boundary with the sync area). **Category:** security. **Severity:** high. The reviewer said critical; the verifier rated it high because it needs an invited user with AUTH_MODE on, and anonymous and kiosk-key callers are rejected.
- **Location:** `api/routers/events.ts:229-240` (`push: eventProcedure`); `api/trpc.ts:116-124, 144-155, 167`; `docs/system/authentication.md:231-232` (documents this as intended)
- **What is wrong:** `eventProcedure` only checks that a user is signed in and that the event exists; it resolves no capabilities. Through `push`, a user can apply `result.applied`, `runner.deleted`, `runner.registered`, `runner.updated`, `finish.adjusted`, `punch.removed`, `card.read`, `class/course/control.upserted` and `reference.imported` entries. The dedicated routers require `race.operate`, `event.manage` or `courses.edit` for the same writes (`cardReadout.applyResult` is on `raceOperateRaceProcedure`, :805; `runner.delete` is on `manageRaceProcedure`, `runner.ts:588`). A user with no grant on an event resolves to no capabilities (`api/permissions.ts:132-153`) and still passes.
- **Scenario:** with AUTH_MODE on, a user invited only as `member` (view rights) on event A sends `events.push` with `x-competition-id: B` and a `runner.deleted` or `result.applied` entry. It is applied in B.
- **Fix (M):** split the two callers. A valid `x-oxygen-sync-secret` (node shipper, `api/sync/shipper.ts:91-108`; check it as `peerProcedure` does, `trpc.ts:188-205`) accepts all entry types. Otherwise map each entry type to a capability: race types need `race.operate`, `runner.deleted` needs `event.manage`, and reference upserts need `courses.edit`. Return unauthorised entries in `failed`, surface them in the station outbox UI, and update `authentication.md:231`. Add a test that expects FORBIDDEN for a member. While doing this, also check whether a secret-only shipper push to a node with AUTH_MODE=proxy is rejected by `authedProcedure`.
- **Verified:** confirmed from code.

### SI-08 `result.applied` ingest maps every status except OK, MP and DNF to `unknown`
- **Area:** readout processing / sync. **Category:** functional. **Severity:** high
- **Location:** `api/routers/events.ts:403-410` (the ternary inside `case "result.applied"`, :391-416)
- **What is wrong:** the ingest maps 1 to ok, 3 to missing_punch, 4 to dnf, and everything else to `unknown`. It does not use `valueToRunnerStatus`, which is already imported and used by the neighbouring `finish.recorded` case. `applyResult` and `acceptVariant` (`cardReadout.ts:842-852, 925-935`) and the client outbox (`DeviceManager.tsx:521, 573`) journal NoTiming (2), OverMaxTime (6), OutOfCompetition (15), and the unchanged current status, under this same entry type.
- **Scenario:** a runner in a no-timing class reads out on the venue node. The node stores `no_timing` and ships `{status: 2}`, and the cloud node stores `unknown` with a finish time. The nodes disagree, and LiveResults omits or mis-ranks the runner. The same happens on every outbox drain.
- **Fix (S):** replace the ternary with `valueToRunnerStatus(status)`, and add an ingest test for statuses 2, 6 and 15. There is no ingest test for this entry type at all today. Apply the SI-01 guard here too.
- **Verified:** confirmed from code.

### SI-09 Punches are re-sorted by clock time before matching: false MP on a mis-set control clock, and broken night events across midnight
- **Area:** readout processing. **Category:** functional. **Severity:** high
- **Location:** `api/routers/cardReadout.ts:214-229` (sort at :227-229), `:252-254` (running time); `api/timeConvert.ts:24-27` (`toAbsolute` wraps modulo 24 h); `packages/shared/src/readout.ts:344-378` (ordered matcher); `web/lib/offline/local-readout.ts:186-200`
- **What is wrong:** card punches are converted to absolute time-of-day and the whole list is sorted by time, which throws away the card's own punch order. The ordered matcher then misses any control that sorts ahead of its predecessor. Across midnight, post-midnight punches wrap to small values and sort first, and `finish - start` goes negative, so running time becomes 0.
- **Scenarios (reproduced with the real functions):**
  - Course 31-32-33, and control 32's clock is an hour behind. In card order the result is missing 0, status OK. Sorted, it is missing 1, status MP. That is MP for every runner on every course through 32.
  - Night event with zero time 22:00, start 23:30, punches 23:50, 00:10 and 00:20, finish 00:30. Sorted, the result is missing 2 and MP. The offline path keeps card order but still gets running time 0, so it keeps the old status instead of OK.
- **Fix (M):** keep card punches in card order and insert free punches by time (before the first card punch with a later time). Do the matching and running-time arithmetic in unwrapped, zero-time-relative deciseconds, and convert to absolute only for output. Fix `local-readout.ts` the same way, and add tests for both scenarios.
- **Verified:** confirmed and reproduced.

### SI-10 A manual finish from the Finish Station and the card readout conflict, and a later read erases the manual finish
- **Area:** readout processing / finish. **Category:** functional. **Severity:** high
- **Location:** `api/routers/race.ts:320-386` (`recordFinish` writes only `finishTime` at :346); `packages/shared/src/readout.ts:326` (`finishTime = finishPunch?.time ?? 0`); `api/routers/cardReadout.ts:238-266, 832-839`; `api/routers/events.ts:352-366`; `web/pages/FinishStation.tsx:131-142, 154-157, 224-227, 230-234`
- **What is wrong:**
  - `recordFinish` writes the finish time and returns `performReadout`, which ignores `runner.finishTime` and takes the finish only from a finish punch. A runner without a finish punch therefore comes back as DNF with running time 0, and the row is left with a finish time and status `unknown`.
  - Offline, `finish.recorded` sets `status: "ok"` and first write wins, while the online path journals `finish.adjusted` with last write wins. The two paths disagree.
  - A later card read with no finish punch then goes through `applyResult`, which writes DNF and finish 0 over the manual finish.
  - `FinishStation` queues offline only when `navigator.onLine` is false. When it does queue, it stamps a new `new Date()` instead of the key-press time.
  - `handleKeyDown` is not guarded by `isPending`, so a double Enter sends two finishes.
- **Scenario:** the finish unit fails, so the crew times runners on the Finish Station. The screen says "finished" with time 0. At readout the card has all controls but no finish punch, so the kiosk shows DNF and the manual finish is set to 0.
- **Fix (M):** in `performReadout`, when there is no finish punch and `runner.finishTime != 0`, use the runner's time (converted with `toAbsolute`) and flag `finishSource: "manual"`. Give the online and offline manual finish one status rule and one overwrite rule. Never write finish 0 over a non-zero finish, in `applyResult` or in the `result.applied` ingest (SI-01). On the client, capture the time once at the key press, queue on any network-class error (not on NOT_FOUND or auth errors), and guard Enter with `isPending`.
- **Verified:** confirmed from code.

### SI-11 Pushing a readout-station backup stores the card but never applies a result
- **Area:** readout processing / backup recovery. **Category:** functional. **Severity:** high
- **Location:** `api/routers/cardReadout.ts:1572-1655` (`pushReadoutBackup`: only `storeReadoutImpl` at :1607, the flag at :1620 and the journal at :1627); `web/pages/BackupPunchesPage.tsx:98-100`; `docs/system/registration-and-readout.md:897, 912`
- **What is wrong:** nothing writes the runner's status, start or finish, and the page only refetches. The doc (§11 step 5) promises "result computation … as if the readout had just happened live". The result lists read the stored row (`api/routers/lists.ts:171-178`), so pushed runners have no result. The on-demand `readout` query does show a computed result, which makes the gap easy to miss.
- **Scenario:** Oxygen was down and runners read out on a standalone station. Afterwards the operator imports and pushes 300 backups. All show "pushed", the results list is still empty, and the operator has to edit 300 runners by hand.
- **Fix (S–M):** in the same transaction, when `linkedRunnerId` is set, run `performReadout` and write the result plus a `result.applied` journal entry as `applyResult` does. `acceptVariant` at ~:890 is the in-transaction pattern to copy; use the shared helper from the summary. Skip when the read is not relevant, apply the SI-01 guards, and add a "push all pending" button. Add status and time assertions to `api/__tests__/integration/readout-backup.test.ts:119-152` and correct the doc.
- **Verified:** confirmed from code.

---

## Medium

### SI-12 The Bluetooth reader stays "reading" on a dead link when the link drops during setup
- **Area:** Bluetooth reader. **Category:** stability. **Severity:** medium
- **Location:** `web/lib/reader-bt/connection.ts:405-445` (ReadDeviceInfo, ReadAllSettings and battery errors are caught and warned; `.catch(() => {})` at :444), `:446-449` (`setStatus("reading")` without checking `server.connected`), `:660-672` (`onGattDisconnected` returns early during "connecting"/"error"), `:703-710` (a reconnect `finish(true)`s after `open()` resolves)
- **What is wrong:** a link that drops after the three subscribes and before `open()` returns is ignored. `open()` completes, the status becomes "reading", and any reconnect loop that was running ends as a success. Nothing would ever fire again to correct this.
- **Scenario (reproduced with a fake device):** on first connect the link drops at the ReadDeviceInfo write, and the result is `status=reading, gatt.connected=false, isReconnecting=false`. On a reconnect the link drops at the battery read; the reader is still "reading" two minutes later and no further attempt is made. The row shows Ready, and cards simply do not beep.
- **Fix (S):** immediately before `setInfo`/`setStatus("reading")`, add `if (!server.connected) throw new Error("Link lost during setup")`. The existing catch then tears down, and a reconnect attempt returns false and keeps looping. Add the two reproduction cases to `reader-bt-connection.test.ts`.
- **Verified:** confirmed and reproduced.

### SI-13 Frame CRC is computed but never checked; block numbers and backup addresses are not checked either
- **Area:** USB transport. **Category:** stability / unvalidated device input. **Severity:** medium. The reviewer said high; the verifier lowered it, because programming already rejects short replies and the "short reply clobbers PROTO" scenario was refuted (a TypeError in the log template throws before the write).
- **Location:** `web/lib/si-protocol.ts:255, 279` (`crcValid` is set, with no reader anywhere); `web/lib/webserial.ts:458-504` (`handleFrame`), `:567-628` (`handleReadoutBlock` takes the last 128 bytes whatever the block number says), `:749-758`, `:891-990` (`programControl` reads 112 SYS_VAL bytes and writes them back), `:1146`
- **What is wrong:** a frame with a bad CRC is treated exactly like a good one. Extended frames also get no ETX check, so a stray `0x02 0xFF` in leftover bytes can be taken as a frame on its length alone.
- **Scenarios:** a bit error in a card block is stored as the runner's punches. In `programControl`, a bit-flipped SYS_VAL read through the coupling coil is written back and persisted in the field control.
- **Fix (S–M):** at the top of `handleFrame`, drop frames with `!crcValid` (with a `siWarn` naming the command and length), so pending commands time out and retry. Check that the block number (BN at `data[2]`) equals `pendingBlockIndex` and re-request on a mismatch (card blocks have no retry today; see SI-05). Check the backup address echo (SI-06). Add an explicit length guard to `ensureStationConfig` instead of relying on the accidental throw.
- **Verified:** confirmed from code, except the one refuted scenario above.

### SI-14 SI5 12-hour resolution adds 12 h to every later time after any backward step
- **Area:** SI protocol. **Category:** functional. **Severity:** medium (upper edge)
- **Location:** `web/lib/si-protocol.ts:775-778` (`resolveAfter`), `:780-803`, `:722-730` (overflow punches 31–36 pushed with `time: 0`)
- **What is wrong:** whenever a time is below the running floor, even by one second, it gets +12 h, and the shifted value becomes the new floor.
- **Scenarios (reproduced):**
  - Punches at 10:10:00 then 10:09:57 (the second control's clock is 3 s behind). The second punch, every later punch and the finish come out 12 h late: finish 22:20:00 instead of 10:20:00.
  - A second trigger the reviewer missed: an SI5 card with more than 30 punches, read in the morning. Its untimed overflow punches (time 0) push the floor to 12:00, so the finish is always 12 h late, and the overflow punches get a fabricated time of 12:00:00.
- **Fix (S):** roll over only when the backward step is large (for example `floor - t > 6 h`), and keep the floor at `max(floor, t)`. Skip the time-0 overflow punches in the loop. Add both cases as tests. Resolving against the competition zero time, which `readout-backup-format.md:131-138` already names as future work, is the longer-term fix.
- **Verified:** confirmed and reproduced.

### SI-15 A failed `storeReadout` is followed by a result computed from the old Card row; emits are not awaited
- **Area:** client pipeline. **Category:** stability. **Severity:** medium
- **Location:** `web/context/DeviceManager.tsx:408-417` (the catch sets no flag), `:430-438` (`readout.fetch` still runs whenever `navigator.onLine`), `:463-510`; emit sites `:411, 421, 521, 573`; `web/lib/offline/events.ts:72-80`
- **What is wrong:** when the store fails but the next request succeeds (a 500 in the store transaction, or a blip on arena Wi-Fi), the result is computed from the previous stored read of that card number, or from none. In addition, `emitEvent` is async (an IndexedDB add plus localStorage) and none of the four call sites await or catch it. At :411 and :421 a failed emit is the only persistence of that readout, it fails silently, and no `unhandledrejection` handler exists.
- **Scenarios:** a runner with no earlier read is shown "pre-start" at the finish, and no result is applied, now or after the drain (see SI-02). A hire card whose previous holder ran a similar course gets that holder's punches applied to the current runner.
- **Fix (S):** when the store failed, skip the server fetch and go straight to the local-compute branch. Await each `emitEvent` inside try/catch, and show an operator-visible "not saved, read the card again" state.
- **Verified:** confirmed from code.

### SI-16 Readout dedup has no time window and survives a competition switch, so a re-read is silently not stored
- **Area:** client pipeline. **Category:** functional (competition mix-up). **Severity:** medium
- **Location:** `web/context/DeviceManager.tsx:318-321` (`readoutsMatch` compares only card number, times and punches), `:356-358, :418` (both store and queue are skipped for a duplicate), `:268-291` (`setCompetitionNameId` does not clear `recentCardsRef`), `:124` (`MAX_RECENT = 20`); `docs/system/registration-and-readout.md` §2a says "within a short window"
- **What is wrong:** a readout identical to any of the last 20 is treated as "already stored" for the whole page lifetime, whatever competition was active and whether the first store succeeded.
- **Scenario:** an operator reads ten cards while the wrong competition (or a test copy) is open, switches to the right one, and reads them again. Nothing is stored in the right competition; the runners show "pre-start" or no result until the page is reloaded. A related case: a first read with no competition context (SI-03) is not queued, and the re-read inside the competition is then skipped as a duplicate.
- **Fix (S):** key the dedup on (competition, readout), clear the list when the competition changes (decide whether leaving a competition also clears the visible list), and add a `persisted` flag that is set only after `storeReadout` succeeds or the event is queued. Skip only when that flag is set, and add the documented time window.
- **Verified:** confirmed for the cross-competition case. The failed-first-store case holds only when no competition was set, as described.

### SI-17 A slow earlier card overwrites the current card and the kiosk after a later card
- **Area:** client pipeline. **Category:** stability (race). **Severity:** medium
- **Location:** `web/context/DeviceManager.tsx:490, 561, 592` (unconditional `setCurrentCard(value)`), `:498-500, 567-569, 598-600` (unconditional kiosk broadcast), `:703-706` (runs overlap freely); `web/pages/KioskPage.tsx:232-258`; `web/pages/CardReadout.tsx:39-41`
- **What is wrong:** each card's run, after its awaits, sets `currentCard` and broadcasts to the kiosk without checking that it is still the latest card. `setRecentCards` beside it is correctly keyed on id.
- **Scenario:** card A's store hangs on bad Wi-Fi. Card B is read three seconds later and resolves first. Then A resolves, or fails into the local fallback, and the kiosk and the operator's readout page show runner A while runner B stands at the station. The kiosk then times out and resets, so B's result never comes back. With two readers on the hub (USB plus Bluetooth) this needs no slow network at all.
- **Fix (S):** keep a `latestCardIdRef` set at :341. Use `setCurrentCard(prev => prev?.id === id ? x : prev)` at the three sites, and broadcast only when `latestCardIdRef.current === id`. `applyResult`, the offline emits and `setRecentCards` must still run for the stale card. Add a unit test with two interleaved readouts.
- **Verified:** confirmed from code.

### SI-18 The USB reader does not recover after a serial error
- **Area:** USB transport. **Category:** stability. **Severity:** medium
- **Location:** `web/lib/webserial.ts:401-431` (`startReadLoop`: status is set to "error" at :418-423 and never back to "reading"), `:238-243` (`connect()`'s catch nulls `this.port`), `:282-284`; `web/context/DeviceManager.tsx:625-630`
- **What is wrong:**
  - After a non-fatal Web Serial error (buffer overrun, framing), the loop keeps reading, but the status stays "error" and `isConnected` is false.
  - "Connect" then picks this still-open reader and calls `port.open()` on an open port, which throws InvalidStateError. `connect()`'s catch then sets `this.port = null` while the old loop still holds the reader. From then on `write()` silently does nothing (cards are detected but readout commands are never sent), and `disconnect()` cannot close the port.
  - After a fatal error (cable bumped) the loop exits and nothing reconnects: there is no `navigator.serial` connect listener anywhere.
- **Scenario:** the USB cable is bumped at a busy finish. Runners keep inserting cards while Oxygen receives nothing, until someone notices the pill and re-picks the port.
- **Fix (M):**
  - Set the status back to "reading" when the loop gets a new reader after an error.
  - When the loop exits, set `reading = false`, clear the buffer and pending read, and close and null the port.
  - Make `connect()`/`attach()` disconnect first instead of nulling a held port.
  - Add a `navigator.serial` "connect" listener that re-attaches granted ports to an errored connection.
  - Make the error loud on the kiosk.
- **Verified:** confirmed from code. The non-fatal error behaviour follows the Web Serial spec; it was not run in a browser. Correction: the mount-time re-attach (`DeviceManager.tsx:728-750`) does not double-open.

### SI-19 `runner.cardId` goes stale when a runner's card number changes, and a hire card's single Card row is shared by successive holders
- **Area:** readout processing / hire cards. **Category:** functional. **Severity:** medium
- **Location:** `api/routers/cardReadout.ts:176-184` (`performReadout` prefers `cardId` and never checks `cardNo`), `:556-569` (one Card row per (event, cardNo), overwritten), `:1241-1260` (unlink clears only `cardNo`), `:1262-1291` (link path; no `assertCardNotTaken`); `api/routers/runner.ts:77-80` (`buildRunnerUpdateData` sets `cardNo`, never `cardId`; also used by journal apply, so peers go stale too)
- **Scenarios:**
  1. A runner was read with card 111. The runner actually ran with hire card 222, which was read as unknown, so the operator changes the runner's card number to 222. The runner still shows card 111's punches until 222 is read again.
  2. Hire card 222 is reused. A ran with it in the morning; the operator unlinks it and gives it to B. B's readout overwrites the same Card row, and A's `cardId` still points at it. A's splits (`race.ts:156`), receipt, `readoutByRunner` and variant change now compute from B's punches, mixed with A's free punches.
- **Fix (S–M):** whenever `cardNo` changes (`buildRunnerUpdateData`, the unlink path, journal apply), set `cardId` to the current Card for the new number, or to null. Make `performReadout` ignore a linked card whose `cardNo` differs from `runner.cardNo`. Export `assertCardNotTaken` and call it in the link path; today linking a taken card fails with a raw Prisma P2002 error instead of the CONFLICT message.
- **Verified:** confirmed from code.

### SI-20 The readout log drops start/finish/check, and `cardDetail` reads the wrong field
- **Area:** readout processing. **Category:** functional / engineering. **Severity:** medium
- **Location:** `api/routers/cardReadout.ts:516-530` (the log row stores `input.punches` only), `:1125-1140, :1165-1171` (`cardDetail` types punches as `{type, time}`); `web/pages/CardsPage.tsx:696-724`; `api/prisma/schema.prisma:957-978, 962`
- **What is wrong:**
  - `card_readouts` has no columns for the header times. They live only in `cards.punches_raw`, which the next read overwrites, and in the journal payload.
  - `cardDetail` looks for `p.type`, but rows are written as `{controlCode, time}`. So start, finish and check are never found, and every punch is returned with `controlCode: undefined`.
  - The result is that the Cards page drawer shows punch times without control codes, and never shows a start or finish row.
  - `cardDetail` has no test, and `e2e/card-history.spec.ts:36` opens the panel but asserts only the history list.
- **Fix (S–M):** read `controlCode` in `cardDetail`. Add `startTime`, `finishTime`, `checkTime` and `clearTime` columns to `card_readouts`, or, without a migration, parse codes 1/2/3 from `card.punchesRaw` when `card.readoutId` is the latest readout. Fix the stale schema comment at :962 and add an integration test.
- **Verified:** confirmed from code. Part (a) is not total loss, because the journal keeps the header times.

### SI-21 Offline status computation cannot produce NoTiming or OverMaxTime, and its match score differs from the server's
- **Area:** offline readout. **Category:** functional. **Severity:** medium
- **Location:** `web/lib/offline/local-readout.ts:94, 216` (`cls?.noTiming === 1`), `:93, 215` (`cls?.maxTime`), `:242` (`computeMatchScore(expectedPositions.length, …, 0)`), `:347` (wrong type); `api/routers/event.ts:476-491` (dashboard `classInfos`: boolean `noTiming`, no `maxTime`); `api/routers/cardReadout.ts:275-289`
- **What is wrong:**
  - `true === 1` is false, so offline a no-timing runner gets OK with a time and a placement.
  - `maxTime` is never sent to the client, so OverMaxTime cannot happen offline.
  - The offline match score counts skipped positions and never penalises foreign punches. A deflated score can push a valid readout into "pre-start", because offline readouts are only accepted at 0.2 or above (`DeviceManager.tsx:543`).
- **Fix (S):** use `!!cls?.noTiming` and fix the `ClassItem` type. Add `maxTime` to `ClassInfo` and the dashboard, checking that its units are deciseconds. Pass `requiredCount` and the card-sourced `extraPunches` as the server does. Add a parity test (same inputs give the same status as `performReadout`). This depends on SI-08, or the corrected statuses become `unknown` on sync.
- **Verified:** confirmed from code.

### SI-22 `card.read` ingest dedup and the backup hash ignore content
- **Area:** readout processing / sync. **Category:** functional. **Severity:** medium
- **Location:** `packages/shared/src/journal.ts:367-383` (`cardReadIsDuplicate` compares card number and ±60 s only); `api/routers/events.ts:731-773`; `api/routers/cardReadout.ts:459-468` (`computePunchesHash` excludes header times), `:1463-1470` (`skipDuplicates` on `@@unique([eventId, punchesHash])`), `:1602` (`readAt = originalReadAt ?? importedAt`; `originalReadAt` is never written)
- **What is wrong:** on ingest, any read of the same card within 60 s is dropped whatever its content, while the direct `storeReadout` path has no such rule, so the origin node and its peers diverge.
- **Scenarios:**
  - A runner reads out without a finish punch, punches the finish unit beside the reader, and reads again within a minute. The origin stores both reads; a peer or the drained outbox keeps only the first, which says DNF.
  - All records of one backup import share the same `importedAt`, so two backups of the same hire card (two runners, different punches) always collide on every receiving node.
  - Two backup readouts that differ only in the finish time collapse into one, and the first one in wins.
- **Fix (S–M):** dedup on a content hash (card number, header times and punches) inside the window, and use the same rule in the direct path. Include header times in `computePunchesHash`, with a backfill migration of `punches_hash`.
- **Verified:** confirmed from code.

### SI-23 The server's "time of day" uses the process time zone, which is UTC in Docker
- **Area:** readout processing / race clock. **Category:** functional. **Severity:** medium (display only, but it misleads runners at the start)
- **Location:** `api/routers/race.ts:87-93` (`getHours()` etc.; the doc comment at :82-86 claims "event's local timezone"); consumers `web/pages/KioskPage.tsx:1152-1171`, `web/pages/FinishStation.tsx:36-38, 246, 257`, `web/pages/StartStation.tsx:39, 53, 113, 140`; no `TZ` in `Dockerfile` (`node:24-slim`) or any `docker-compose*.yml`
- **What is wrong:** start times are local wall-clock time, but the server's clock is UTC in a container.
- **Scenario:** in a Docker deployment in Sweden, the kiosk and Start Station countdowns are off by 1–2 hours ("started 58 minutes ago" for a runner who starts in 2 minutes), and the Finish Station clock is wrong. The recorded finish uses the browser clock and is not affected.
- **Fix (S):** set `TZ: "${TZ:-Europe/Stockholm}"` for the api service in every compose file and check it once in the built image. The more robust fix (M) is a shared helper that computes time of day in a configured time zone with `Intl.DateTimeFormat`, used here and by the same `getHours()` pattern at `api/routers/event.ts:401`, `runner.ts:355`, `lists.ts:52` and `timeConvert.ts:45`, which were not traced further.
- **Verified:** confirmed from code. UTC in the container follows from the image default; it was not run in Docker.

### SI-24 Punch loops skip blank records and read past the punch counter
- **Area:** SI protocol. **Category:** functional. **Severity:** medium
- **Location:** `web/lib/si-protocol.ts:848-864` (SI8 family), `:922-939` (SI10/SIAC); `parsePunchRecord` `:400-414`
- **What is wrong:** both loops run until `punches.length < punchCount`. A record with control code 0 or time 0xEEEE inside the first `punchCount` slots is skipped, and the loop then appends a stale record from beyond the counter (a previous race on an uncleared card). A stale control appended this way can wrongly satisfy the course check.
- **Fix (S, together with SI-04):** iterate by global slot index `< punchCount`. Decide separately whether to keep a record that has a code but no time, which is dropped today.
- **Verified:** confirmed from code. A repro test was written but not run, because the checkout has no `node_modules`.

### SI-25 SI6 cards, and SI8+ cards in unlisted number ranges, produce an empty "readout" with no error
- **Area:** SI protocol. **Category:** functional / docs. **Severity:** medium
- **Location:** `web/lib/webserial.ts:518-536` (when `!supportsFullReadout`, an empty `si:card-readout` with no ACK; the comment "SI5/SI6 detection only" is stale for SI5); `web/lib/si-protocol.ts:81-90` (no SI6 in `BLOCKS_TO_READ`), `:92-107` (`getCardType`, including the 2003001–2003400 "SI6" carve-out inside the SI8 range at :98, and many "Unknown" ranges); docs claiming SI6 support: `docs/system/registration-and-readout.md:121`, `docs/architecture.md:193`, `docs/guide/platform.md:75`
- **What is wrong:** an SI6 card, or any card announced with the SI8+ detection whose number is outside the hard-coded ranges, is stored as a card with no punches. It gets no beep, and nothing tells the operator the card type is unsupported.
- **Scenario:** an SI6 runner finishes. The empty card is stored, the action is "register" or "pre-start", and the finisher is shown as not started. (Through SI-01, an empty re-read could also wipe an existing result.)
- **Fix (S, or M for SI6 support):** at minimum, emit `si:card-unsupported` (or `unsupported: true`), do not store it, and show an error. Fix the three doc lines and the two stale comments. Implementing the SI6 readout (0xE1, blocks 0/6/7) is M. For an "Unknown" card detected via 0xE8, try the SI8+ read and take the layout from the series byte. Confirm or remove the 2003001–2003400 carve-out.
- **Verified:** confirmed from code.

### SI-26 Control backup decoding: SI5 series-1 cards get +100000, and records outside 2020–2030 are silently dropped
- **Area:** SI protocol / backup recovery. **Category:** functional. **Severity:** medium (the series bug). The year window is low today and becomes high on 2031-01-01.
- **Location:** `web/lib/si-protocol.ts:1582-1584` (series 1–4 multiplied), compared with `:321-325` and `:688-692` (series 0/1 taken as the raw number); `:1617-1620` (year window; `siLog` is debug-only); only caller `web/lib/webserial.ts:1176`, reached from `ControlsPage.tsx:1578`
- **Scenario (reproduced):** record bytes `01 30 39` decode to card 112345 instead of 12345. Records dated 2031 or 2000 decode to nothing, so from 2031, or from a station whose clock was never set, every control backup reads as empty and no warning is shown.
- **Fix (S):** add one shared `decodeSI5CardNumber(series, raw)` used at all three sites, with series 0/1 taken as raw. Just narrowing the condition is not enough, because series 1 would then fall into the 24-bit branch. Widen the year window to the field's 2000–2063 range, return a count of skipped records for the UI, and add unit tests (there are none for `parseBackupPage`).
- **Verified:** confirmed and reproduced in code. That real stations write series byte 1 for low SI5 numbers is plausible (the reference implementation handles it) but not proven on hardware.

### SI-27 Sunday is decoded as "unknown weekday" on USB and written as 7 when programming a station
- **Area:** SI protocol. **Category:** functional. **Severity:** medium (Sunday is the usual race day; on Sundays the USB staleness check does nothing)
- **Location:** `web/lib/si-protocol.ts:368-371` (`parseDayOfWeek` returns null for 0), `:1322-1325` (`buildSetTime` writes 7 for Sunday); `web/context/DeviceManager.tsx:187-216` (`isPunchDataFresh` treats null as fresh); `web/lib/reader-bt/protocol.ts:531-535` (Bluetooth maps index 0 to Sunday, verified on hardware per `docs/si-protocol/reader-bt.md:160, 329`); tests that lock in the behaviour at `web/lib/__tests__/si-protocol.test.ts:1351-1352, 1367-1370`
- **What is wrong:** in the SPORTident TD byte, weekday bits 000 mean Sunday. A card last used on any Sunday is treated as "weekday unavailable, assume fresh" on any later day, so a stale card from last Sunday's race is not flagged. The two transports disagree.
- **Fix (S):** in `parseDayOfWeek`, map 0 to 7, and treat 7 as null or as Sunday for tolerance. In `buildSetTime`, write 0 for Sunday. Update the two tests and add a `buildSetTime` test. Confirm with one card punched on a Sunday and read over USB before merging.
- **Verified:** the code behaviour is confirmed. The spec premise (000 = Sunday) is plausible: it agrees with the Bluetooth hardware finding and the capture, but the capture has no Sunday record.

### SI-28 SI5 readout requests non-existent extra blocks, delaying the beep and dropping a read when the next card comes quickly
- **Area:** USB transport. **Category:** functional / performance. **Severity:** medium. The reviewer said low-medium; the verifier raised it because of the dropped-read consequence.
- **Location:** `web/lib/webserial.ts:593-619` (byte 22 used as a punch count for every card type), `:539-543` (a new detection resets `pendingBlocks` without finalizing)
- **What is wrong:** on an SI5, byte 22 is the low byte of the finish time. For about 90% of values it is above 24, so 2–9 bogus block requests are sent, and the readout and beep wait for them or for the 2 s timeout. If the next card is inserted during that wait, `initiateReadout` resets the state and the first card's readout is silently dropped.
- **Fix (S):** for SI5, leave `pendingTotalBlocks = 1` (or use a per-type table, as in SI-04). Finalize, rather than discard, a pending readout when a new detection arrives. Add a state-machine test with an SI5 block whose byte 22 is 0xEE, asserting that exactly one read command is written.
- **Verified:** confirmed from code. The station's reaction to the bogus requests was not checked on hardware.

### SI-29 Online, a readout is written to the local journal only after the network call fails
- **Area:** client pipeline. **Category:** stability. **Severity:** medium (low end)
- **Location:** `web/context/DeviceManager.tsx:358-417`, `:259` (mutation with no options); `web/lib/node-discovery.ts:218-227` (a plain `fetch` with no AbortSignal); `web/vite.config.ts:65-71` (the service-worker timeout applies to GET only); `docker/nginx.conf:24, 34` (`proxy_read_timeout 120s`)
- **What is wrong:** while `navigator.onLine` is true, the readout exists only in React state until `storeReadout` rejects. On a black-holed network the mutation can hang for up to about two minutes, and a reload or crash in that window loses the readout.
- **Fix (S–M):** write the `card.read` journal entry first (the server already dedups it, see SI-22), and mark it synced when `storeReadout` succeeds so it is not re-sent. Add a 5–8 s AbortSignal timeout on the mutation as well, and await the emit (SI-15).
- **Verified:** confirmed from code.

### SI-30 Tests: readout processing has untested core paths and misplaced or dead tests
- **Area:** readout processing. **Category:** tests. **Severity:** medium
- **Location / gaps:**
  - `computeStatus` (`packages/shared/src/readout.ts:548-577`) has no unit test, so the OverMaxTime, OutOfCompetition and NoTiming priority and the keep-current fallback are untested.
  - No test reads out after `addPunch` adds a free punch (the merge and sort at `cardReadout.ts:218-229`), and none covers midnight or a mis-timed punch.
  - `pushReadoutBackup` tests never assert the runner's result.
  - No test pushes a `result.applied` entry at all (`events-push.test.ts`).
  - DeviceManager's offline and failed-store branches have no test, and `local-readout.test.ts` covers variants only.
  - A re-read after a result is covered only at e2e level with unchanged punches (`e2e/kiosk-readout.spec.ts:380-427`).
- **Low value:** `api/__tests__/cardReadout.test.ts` tests shared pure functions through API re-exports (`cardReadout.ts:46-61`, which no production code imports). Its `computeReadId` block (`:593-658`) tests a function with no production caller.
- **Fix (M):** add a `computeStatus` table test in `packages/shared`, and move the pure-function tests there, dropping the re-exports. Delete `computeReadId` and its tests. Add integration tests for a free punch followed by a readout, a backup push followed by a runner result, and `result.applied` ingest including status 2, 6 and 15. Add the SI-01 re-read scenarios at API level.
- **Verified:** confirmed from code, with two sub-claims narrowed as noted above.

### SI-31 Tests: the USB state machine has no unit tests, and several protocol tests cannot fail
- **Area:** SI protocol / USB transport. **Category:** tests. **Severity:** medium (SI-04, SI-05, SI-13 and SI-28 would all have been caught)
- **Location / gaps:**
  - `SIReaderConnection` (`web/lib/webserial.ts:168`, 1,338 lines) has no unit test. Its only coverage is 10 happy-path Playwright tests through `e2e/helpers/mock-webserial.ts`, which uses the same wrong card layout as the parser, emits only SI8+ detection, and never produces a bad CRC, split chunks or a timeout.
  - `buildSetTime`, `encodeStationCode`, `decodeStationCode`, `parseTimeDrift` and `parseBackupPage` have no tests.
  - `addRecentCard` has no test.
- **Low value:**
  - `si-protocol.test.ts:905-920` asserts only `typeof number`.
  - `si-protocol.test.ts:1474-1490` restates constants.
  - `si-protocol.readout-backup.test.ts:138-145` ("parses card 7") asserts card type and count but no punches. (`:1004-1028` tests real predicates and is fine.)
- **Fix (M):** add `webserial.test.ts`, which drives `SIReaderConnection` through a fake `SerialPortLike` using frames from the capture. It should cover multi-block sequencing, split frames, bad CRC, timeout, card removed mid-read, SI5, and a stream error, and assert full punch lists for all fixture cards against `readouts.txt`. Add table tests for the five pure functions, tighten `:905-920` to exact values, and delete `:1474-1490`.
- **Verified:** confirmed from code, with three small corrections applied above.

### SI-32 The kiosk `ReadoutScreen` has no `key`, so back-to-back readouts skip the auto-print and the kiosk finish
- **Area:** readout pages. **Category:** stability. **Severity:** medium. The reviewer said low; the verifier found a normal trigger with two readers.
- **Location:** `web/pages/KioskPage.tsx:475` (no key), `:721-722, 808` (refs never reset), `:245-252, 331-342`
- **What is wrong:** with two readers (supported), the sequence "A detects, B detects, A reads out, B reads out" goes straight from one readout screen to the next. `printedRef` is already true, so card B gets no auto-print, no kiosk-side `recordFinish` (:735) and no rental sound. A lost `card-reading` message does the same.
- **Fix (S):** `key={screen.card.id}` (a per-read id).
- **Verified:** confirmed from code.

---

## Low

### SI-33 Zero means both "a time" and "no time"
- **Area:** readout processing. **Category:** functional. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:216-218, 485, 552`; `api/timeConvert.ts:15-17, 24-26`; `packages/shared/src/readout.ts:325-326, 552`
- **What is wrong:** a punch exactly at zero time becomes relative 0, which means "no time". As a finish punch it gives DNF, and an assigned start equal to zero time is treated as no start.
- **Fix:** nullable times (L), or validate that the first start is after zero time (S).
- **Verified:** confirmed.

### SI-34 `encodePunchesRaw` mis-encodes negative relative times
- **Area:** readout processing. **Category:** functional. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:486-487`, decoded at `packages/shared/src/readout.ts:135-137`
- **What is wrong:** a punch before zero time at -15 ds is written as `-2.-5` and read back as -25 ds. Any negative time that is not a whole second is off by 1 s.
- **Fix (S):** encode using the sign and the absolute value.
- **Verified:** plausible. The SI-33 verifier found it from code, and it was not separately verified.

### SI-35 `applyResult` turns a punched start into an assigned start
- **Area:** readout processing. **Category:** functional. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:838-839` with `:238`; `packages/shared/src/readout.ts:325`
- **What is wrong:** the card's start punch is written to `runner.startTime` and from then on wins over a later card start. A re-run on the same entry gets finish₂ − start₁, a silently long time.
- **Fix (S):** do not write `startTime` when it came from the card, or store its source.
- **Verified:** confirmed.

### SI-36 Two concurrent first reads can create two Card rows
- **Area:** readout processing. **Category:** stability. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:556-580` (find, then create); `api/prisma/schema.prisma:914-915` (non-unique index)
- **Fix (S–M):** a partial unique index on `(event_id, card_no) WHERE NOT removed`, plus an upsert, or catch P2002 and retry. This needs a migration and a dedup of existing rows.
- **Verified:** confirmed.

### SI-37 `pushReadoutBackup` can push the same backup twice
- **Area:** readout processing. **Category:** stability. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:1577-1593` (the `pushedAt` check is outside the transaction), `:1620`
- **What is wrong:** two clicks or two tabs give two readouts, `readCount` +2 and two `card.read` entries.
- **Fix (S):** claim the row first inside the transaction with `updateMany({where: {id, pushedAt: null}})`.
- **Verified:** confirmed.

### SI-38 `cardList` loads every readout with its punches
- **Area:** readout processing. **Category:** performance. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:1026-1042`
- **What is wrong:** it fetches all `card_readouts` rows with their JSON punches to pick the latest per card, and the set grows with every re-read.
- **Fix (S):** use `distinct: ["cardNo"]` with `orderBy [cardNo, readAt desc]`, and store a punch count.
- **Verified:** confirmed.

### SI-39 `addPunch` can link the wrong control
- **Area:** readout processing. **Category:** functional. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:1306-1313` (`codes: { contains: "31" }`)
- **What is wrong:** code 31 also matches controls coded 131, 310 or "45;231".
- **Fix (S):** reuse the exact-match filter from `api/routers/control.ts:167-170`.
- **Verified:** confirmed.

### SI-40 Hire-card flag is inconsistent between the Cards page and the readout
- **Area:** hire cards. **Category:** functional. **Severity:** low
- **Location:** `api/routers/cardReadout.ts:304` (`cardFeeCents !== 0`, correct), `:1075, 1161` (`> 0`)
- **What is wrong:** negative fees mean "rental, use the event base fee" (`runner.ts:245-251`, `eventor.ts:1760-1763`), so the Cards page list and drawer show those runners as not renting.
- **Fix (S):** use `!== 0` everywhere.
- **Verified:** confirmed.

### SI-41 Readout processing: dead code and docs that describe the old implementation
- **Area:** readout processing. **Category:** engineering. **Severity:** low
- **Location:**
  - Unused `computeReadId` and `parseCourseControls` (`cardReadout.ts:51, 53`)
  - Unused input `punchesFresh` (see SI-01)
  - Stale `void RunnerStatus` (`cardReadout.ts:1659`; the import is used)
  - Write-only refs and the `setPendingConfirmCardNo` setter (`DeviceManager.tsx:113, 255-257, 785-788, 815`)
  - `docs/system/registration-and-readout.md` §2c (:147), §3b–§3h (:232-320) and §10 (:849-885), which describe oCard, raw-SQL `oxygen_card_readouts`, ReadId dedup, `{cardId, created, punchesRelevant}` and `incrementCounter()`
- **Fix (S):** delete the dead code and rewrite those doc sections to match the current code.
- **Verified:** confirmed.

### SI-42 `parseTransmitRecord` decodes the wrong bytes, and transport dead code
- **Area:** SI protocol. **Category:** engineering. **Severity:** low (it would become high if online punches are ever wired up)
- **Location:**
  - `web/lib/si-protocol.ts:986-996`: the card is taken from `data[2..4]` and the time from `data[6..7]`, and its test at `si-protocol.test.ts:981-999` uses the same wrong layout
  - `web/lib/webserial.ts:496-502`: emits `si:punch`, which has no listener
  - Dead: `VALID_COMMANDS` (`si-protocol.ts:1017`), `tryAutoReconnect` (`webserial.ts:248`), the events `si:station-read`, `si:control-programmed` and `si:backup-read`
  - Duplicated JSDoc at `si-protocol.ts:941-945, 1346-1350` and `1524-1550`; the last pair contradict each other on the record layout
- **Fix (S):** delete `parseTransmitRecord`, the `si:punch` branch and its test, or fix them (card `data[2..5]`, TD `data[6]`, time `data[7..8]`) and test against a real frame. Delete the other dead exports, and keep only the `parseBackupPage` JSDoc that matches the code.
- **Verified:** confirmed.

### SI-43 Connecting a USB station silently rewrites its PROTO and FEEDBACK configuration
- **Area:** USB transport. **Category:** engineering. **Severity:** low
- **Location:** `web/lib/webserial.ts:283-305, 314-357` (line 340: `(proto | 0x05) & ~0x02`); `web/context/DeviceManager.tsx:728-749` (auto-attach on page load); this contradicts `web/lib/si-protocol.ts:1152-1155` and `docs/bugfixes/check-station-autosend.md`
- **What is wrong:** every connect, including the automatic attach on page load, persistently clears autosend and forces handshake on whatever station is plugged in, in any mode. The only trace is a debug-only log line.
- **Fix (S):** write PROTO only when the station is in readout mode, show a visible notice with the old and new values, and make the two comments agree on who owns the autosend bit.
- **Verified:** confirmed.

### SI-44 Bluetooth: a late card answer is emitted twice
- **Area:** Bluetooth reader. **Category:** stability. **Severity:** low
- **Location:** `web/lib/reader-bt/connection.ts:544-570, 618-637, 487-506`
- **What is wrong:** a late answer to a timed-out first attempt resolves the retry, and the retry's own answer then arrives as unsolicited and is emitted (and beeped) a second time. DeviceManager's dedup hides the duplicate.
- **Fix (S):** compare the card number with `pendingCard`, or swallow one stray CARD_DATA after a timeout.
- **Verified:** confirmed.

### SI-45 Bluetooth: `sleep()` leaks an abort listener on every reconnect poll
- **Area:** Bluetooth reader. **Category:** stability. **Severity:** low
- **Location:** `web/lib/reader-bt/connection.ts:810-818`, `:736`
- **What is wrong:** the reconnect window is unbounded, so about 360 listeners accumulate per hour.
- **Fix (S):** remove the listener when the timer fires.
- **Verified:** confirmed.

### SI-46 Bluetooth: the device-supplied message length is not capped
- **Area:** Bluetooth reader. **Category:** security (device input). **Severity:** low
- **Location:** `web/lib/reader-bt/protocol.ts:196-207`
- **What is wrong:** only a misbehaving paired device could grow the buffer.
- **Fix (S):** reject totals above a few KB.
- **Verified:** confirmed.

### SI-47 Bluetooth: the reconnect window is documented as 60 s but is unbounded
- **Area:** Bluetooth reader. **Category:** docs. **Severity:** low
- **Location:** `web/lib/reader-bt/connection.ts:15, 278` and `docs/si-protocol/reader-bt.md:280` say 60 s; `RECONNECT_WINDOW_MS = Infinity` at `connection.ts:112`
- **Fix (S):** correct the comments and the doc.
- **Verified:** confirmed.

### SI-48 USB: readout writes are fire-and-forget, and `disconnect()` leaves timers armed
- **Area:** USB transport. **Category:** stability. **Severity:** low
- **Location:** `web/lib/webserial.ts:476, 491` (async calls neither awaited nor caught; a failed write leaves `pendingCardType` set with no timer), `:363-387` (`disconnect()` does not clear `blockTimeoutId` or reject `commandResolver`)
- **Fix (S):** catch both calls, clear the pending state and log; clear the timer and reject the pending command on disconnect.
- **Verified:** confirmed (harmless in most sequences).

### SI-49 A dead TestLab injection listener ships in production
- **Area:** client pipeline. **Category:** engineering. **Severity:** low
- **Location:** `web/context/DeviceManager.tsx:283-288`
- **What is wrong:** an unvalidated `BroadcastChannel` readout injection is active in production builds. Nothing in the repo sends to it, and it is same-origin only.
- **Fix (S):** delete it.
- **Verified:** confirmed.

---

## Clean

- `web/lib/reader-hub.ts`: clean. Listeners are unwired on remove, the aggregate status is right, and the tests are adequate.
- `web/components/ReaderConnectionDialog.tsx`, `CardNotification.tsx`, `RecentCards.tsx`, `pages/CardReadout.tsx`: no logic bugs found, apart from the SI-17 follow-on.
- The Bluetooth decoder (`reader-bt/protocol.ts`, `toSICardReadout`) and its three test files: bounds-checked and consistent with `docs/si-protocol/reader-bt.md`, with hardware fixtures.
- `si-protocol.ts`: CRC computation, frame building, the SI5 block layout, the SI10/SIAC layout (proven by the capture: 18 punches plus owner data) and the station-programming byte logic.
- Competition scoping inside `cardReadout.ts`: every query filters on `ctx.event.id`, and by-id lookups re-check `eventId`. The store, apply, acceptVariant and punch-edit transactions are atomic with their journal entries. `statusConvert.ts` and `card-read-payload.ts` are clean.

## Not reviewed or could not verify

- **No hardware:**
  - SI9 and pCard punch offsets (SI-04)
  - Sunday as weekday 000 in the TD byte (SI-27)
  - series byte 1 for low SI5 numbers in station backup (SI-26)
  - the real 0xD3 frame layout (SI-42)
  - what a BSM station sends when a card is pulled mid-read (SI-05)
  - how a station reacts to bogus SI5 block requests (SI-28)
  - tCard layout, SI10/SI11 owner-data edge cases, the SIAC battery-voltage formula, and `parseSI10Metadata` offsets (`si-protocol.ts:590-594` reuses the battery year and month for the production date, which looks doubtful)
- **Not run:** no e2e suite and nothing needing a database. Reproductions ran with node's type stripping against the real functions, because the checkout had no `node_modules`.
- **Platform behaviour:** Web Serial non-fatal error behaviour (SI-18) follows the spec and was not run in a browser. The UTC container time zone (SI-23) follows from the image default and was not run in Docker.
- **Outside this area's read:** the web outbox drain (`lib/offline/` sync worker, `projection.ts`, `useStationSync`), whose retry and duplicate behaviour belongs to the offline/sync area. `resolveCourseExpectedPositions`, `variants.ts` and `race.finishReceipt` split computation were read only as callees. The layout JSX of `CardsPage.tsx` and `BackupPunchesPage.tsx`, and the KioskPage registration and settings screens, were read for logic only.
- **Open design question:** a kiosk-key-only device needs `race.operate` for `storeReadout` and `applyResult`, and a signed-in user for `events.push`. With AUTH_MODE on, such a device could show results while storing nothing. The intended setup was not confirmed.
- **Not traced:** how the result lists treat `finishTime > 0` with status `unknown`, which affects the visible impact of SI-08 and SI-10.

# Area 03: Prisma schema, migrations and data access

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Review only: no code was changed.

- **Basis**: `main` at `df5460c3`, plus PR #254 (`claude/project-thread-avzbks`) where it touches this area. Findings in the PR are marked **PR254**.
- **Scope**: `packages/api/prisma/schema.prisma`, all 68 migrations and PR254's three, how migrations reach a running system (Dockerfile, compose files, runbooks, `backup.ts`), and the data-access code on the competition-critical paths (registration, readout, results, draw, journal sync, lease, Eventor, online input, LiveResults) and on the course, control and map-store paths: transactions, partial writes, races, event scoping, N+1 and unbounded queries.
- **Method**: three Fable reviewers read the code in full, split into schema and migrations, competition data access, and course/map data access. Each finding then went to its own Fable verifier, which saw only the location and the claim and was asked to disprove it. Severities below are the verifier's, adjusted where noted. Findings that did not survive are listed at the end.
- **Status**:
  - **Confirmed (reproduced)**: reproduced on a throwaway PostgreSQL 16 cluster, or with a script against the real module.
  - **Confirmed**: proven by reading the code path end to end.
  - **Plausible**: the logic holds, but the trigger was not shown.

Several findings sit on the boundary with other areas (sync, readout, Eventor, auth, LiveResults). They are kept here because they were found through their database writes. The merge into the full review should deduplicate them against those areas.

## Summary

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 12 |
| Medium | 22 |
| Low | 17 |

**Fix these five first:**

1. **DB-01**: a per-event `seq` counter that is never raised by journal replay. After a venue lease is checked in, every new runner, class, course or control on the cloud fails, permanently. This also hits the box on the next checkout. Size S–M.
2. **DB-02**: the journal shipper skips entries that arrive late with an old timestamp, and the checkin barrier still reports zero pending. Readouts from a station that was offline never reach the cloud. Size M–L.
3. **DB-08**: Eventor `sync` cancels every Eventor-linked runner when an entry list comes back empty, and on every sync it cancels runners that came only from results. It also reverts class and card edits made at the desk. Size M.
4. **DB-03**: journal replay stores no-timing, over-max-time and out-of-competition results as `unknown`, on the cloud and on the venue server when a station drains its outbox. Size S.
5. **DB-13 and DB-14**: the event backup silently drops any table it cannot dump, and the journal is already missing. The documented restore cannot succeed for an event with readouts. Fix DB-13 (S) now. DB-14 is the larger follow-up.

Close behind: the online-input (ROC radio) feed, which a reset button can jam for good (DB-06) and whose UI mapping is never applied (DB-07), and a draw at the default first start, which loses one start time per corridor (DB-05).

---

## Critical

### DB-01: Per-event `seq` counter is not raised by explicit-seq inserts, so creates fail permanently after a lease
- **Area**: schema / offline sync. **Category**: stability.
- **Location**:
  - `packages/api/prisma/migrations/20260517_init/migration.sql:141-155`: `allocate_event_seq`, the only definition.
  - `packages/api/src/routers/events.ts:505-508`: `runner.registered` apply.
  - `packages/api/src/routers/events.ts:860-864`: class, course and control upserts.
  - `packages/api/src/routers/lease.ts:224-252`: checkin.
  - `packages/api/src/sync/lease.ts:272-275` and `:356-359`: snapshot export and import of `event_seqs`.
  - `docs/system/offline-architecture.md:268-276`.
- **What is wrong**:
  - The trigger only touches `event_seqs` when `NEW.seq` is 0 or NULL.
  - Journal apply inserts runners, classes, courses and controls with the origin's explicit `seq`, so the receiving node's counter never moves. The path is `runner.ts:477-484` journals `seq`, `sync/shipper.ts:106` pushes it, and `events.ts:507` inserts it.
  - The doc says "At checkin the counters travel back with the barrier". Checkin sends no counters: it only ships, checks pending, and releases.
  - `runner.create` (`runner.ts:425`) has no P2002 retry.
  - The failed insert rolls back the counter increment, so the counter never advances.
- **Scenario**:
  1. The cloud holds runners 1–500, with `next_seq` = 501.
  2. The venue box checks out, registers runners 501–530, ships and checks in. The cloud still has `next_seq` = 501.
  3. The next `runner.create` on the cloud gets 501 and fails on `UNIQUE (event_id, seq)`. Every later create fails the same way until someone edits `event_seqs` by hand.
  4. A re-checkout (day 2 of a multi-day event) exports the stale counter. The box's first registration at the arena then fails the same way.
  5. Classes, courses and controls created on the box behave the same, as does every row after `forceTakeover`.
- **Fix (S–M)**:
  - Add a migration that gives `allocate_event_seq()` an `ELSE` branch for an explicit seq: `INSERT … VALUES (NEW.event_id, TG_TABLE_NAME, NEW.seq + 1) ON CONFLICT … DO UPDATE SET next_seq = GREATEST(event_seqs.next_seq, EXCLUDED.next_seq)`. This covers every table, `forceTakeover` and late drains.
  - In the same migration, repair every `(event, table)` to `MAX(seq) + 1`.
  - Make `importEventSnapshot`'s `eventSeq.createMany` an upsert, because the trigger will already have created those rows.
  - Add an integration test: the venue registers a runner and checks in, then `runner.create` succeeds on the cloud; then re-checkout and register on the box.
  - Correct the doc sentence.
- **Status**: confirmed (reproduced). A private PG16 cluster with the exact function: after explicit seqs 3 and 4, `next_seq` stayed at 3, and two successive default inserts both failed with `duplicate key … (event_id, seq)=(1, 3)`. The call paths were also traced by an independent verifier.

### DB-02: Journal shipper skips entries that arrive below its HLC watermark
- **Area**: offline sync. **Category**: stability (data loss).
- **Location**:
  - `packages/api/src/routers/events.ts:110-134`: ingest keeps the origin HLC.
  - `packages/api/src/sync/shipper.ts:194-220`: push cursor. The pull cursor is at `:233-237`.
  - `packages/api/src/routers/events.ts:198-201`: `listJournalEntriesSince` filter.
  - `packages/api/src/sync/lease.ts:383-406`: `shippingStatus`.
  - `packages/api/src/routers/lease.ts:224-246`: checkin barrier.
  - `packages/api/src/journalEmit.ts:59`.
  - `packages/web/src/context/DeviceManager.tsx:408-424`.
- **What is wrong**:
  - The shipper ships rows with `(hlc, id) > (pushedHlc, pushedId)`.
  - Ingest via `events.push` stores each entry with the station's own HLC (`resolveHlc`, `packages/shared/src/journal.ts:303-305`). `foldServerHlc` only moves the local clock forward. It does not re-stamp.
  - An entry that reaches the venue server after the shipper has acked a newer server entry is stored below the watermark and is never selected again.
  - `shippingStatus` counts with the same predicate, so the checkin barrier reports 0 pending.
  - `appendJournal` mints its HLC before commit (`journalEmit.ts:59`), so a transaction stamped 100 that commits after one stamped 101 has been acked is skipped too.
  - The pull direction has the same hole.
  - `docs/system/offline-architecture.md:318` claims a watermark never skips an entry.
- **Scenario**:
  1. A station is offline for ten minutes and queues `card.read` entries stamped T.
  2. Meanwhile the venue server journals its own entries and the 5 s shipper acks one at T+10 min.
  3. The station reconnects and drains. The entries land with `hlc = T` and are never shipped.
  4. The same happens with the DeviceManager fallback after a failed `storeReadout`.
  5. The operator checks in: the barrier passes, and the cloud resumes as authority without those readouts or finishes.
- **Scope**: only the venue+cloud lease topology (`SYNC_PEER_URL` set). A single-node install has no shipper. The data stays on the venue box until its next checkout wipes it (see DB-27).
- **Fix (M–L)**:
  - Do not re-stamp the HLC, which is the cross-node ordering and LWW key.
  - Add a per-node monotonic arrival column (`ingest_seq BIGSERIAL`). Move the push watermark and `shippingStatus` onto it. Ship only rows below `pg_snapshot_xmin(pg_current_snapshot())`, because sequence values are also allocated before commit.
  - Give `events.since` (pull) the same arrival cursor.
  - As a safety net, make the checkin barrier an id-set reconciliation with the peer.
  - Add a test to `journal-shipping.test.ts` for a late entry with an old HLC.
- **Status**: confirmed, by code reading from two independent reads.

---

## High

### DB-03: `result.applied` replay collapses most statuses to `unknown`
- **Area**: offline sync / results. **Category**: functional.
- **Location**:
  - `packages/api/src/routers/events.ts:404-411`.
  - Origin: `packages/api/src/routers/cardReadout.ts:835`, `:848` and `:911`.
  - `packages/web/src/context/DeviceManager.tsx:521-527` and `:573-579`.
- **What is wrong**: the apply maps 1 to `ok`, 3 to `missing_punch`, 4 to `dnf`, and everything else to `unknown`. The origin journals the raw status, and `computeStatus` (`packages/shared/src/readout.ts:548-578`) yields NoTiming, OverMaxTime and OutOfCompetition in normal use. The neighbouring `finish.adjusted` case (`events.ts:382-383`) already uses the full `valueToRunnerStatus`, which is imported.
- **Scenario**: a runner in a no-timing class is read out. On the cloud, on peers, and on the venue server itself when a station drains its offline outbox, the stored status is `unknown`, so results differ between nodes.
- **Fix (S)**:
  - Replace the ternary with `valueToRunnerStatus(status)`.
  - Add an integration test for statuses 2, 6 and OutOfCompetition through apply.
  - Already-ingested replicas need a one-off re-apply of `result.applied` entries, because idempotency by entry id skips them on re-push.
  - Check `packages/web/src/lib/offline/projection.ts:148` for the same narrowing.
- **Status**: confirmed.

### DB-04: `events.push` reference upserts can overwrite another event's courses, classes and controls
- **Area**: offline sync / security. **Category**: security.
- **Location**: `packages/api/src/routers/events.ts:229` (`push`), `:49-77` and `:681-685` (payload unvalidated), `:843-915` (`applyReferenceUpsert`), `:475-480`. PR254 leaves the same code unfixed at `events.ts:~875-900`.
- **What is wrong**:
  - `applyReferenceUpsert` upserts courses, classes and controls `where: { id: payload.id }` only, with `update: fields` taken unfiltered from a `z.record(z.unknown())` payload.
  - It then runs `courseControl.deleteMany({ courseId })` and `classCoursePool.deleteMany({ classId })` with no event check.
  - The entry's `competitionId` is never compared with the header's event.
  - `fields` can carry `eventId`, `removed` or `seq`, so a row can be moved or soft-deleted.
  - `events.push` itself needs only a signed-in user. That is documented as deliberate (`docs/system/authentication.md:231`).
- **Scenario**: a signed-in user with no capabilities sends `course.upserted` with event B's course UUID under event A's header. Event B's course is overwritten and its controls deleted, silently.
- **Fix (S–M)**:
  - In each branch, look up the existing row's `eventId` and refuse a mismatch.
  - Whitelist the portable columns with zod, or at least strip `id`, `eventId` and `seq`.
  - Check that `controlIds` and `courseIds` in child rows belong to the event.
  - Add `eventId` to the `runner.registered` by-id lookup.
  - Whether `push` should require a capability or the peer secret is a product decision.
- **Status**: confirmed.

### DB-05: A draw whose first start equals ZeroTime stores start time 0, the "no start" sentinel
- **Area**: draw / time conversion. **Category**: functional.
- **Location**:
  - `packages/api/src/timeConvert.ts:15-17`.
  - `packages/api/src/routers/drawRouter.ts:167` and `:190`.
  - `packages/web/src/components/DrawPanel.tsx:112-115` and `:182`.
  - Consumers: `routers/event.ts:724`, `routers/lists.ts:70-72`, `routers/runner.ts:369-371`, `liveresults.ts:420` and `:445`.
- **What is wrong**:
  - `toRelative(abs, zt)` returns `abs - zt` with no guard, so a start equal to ZeroTime becomes 0.
  - DrawPanel's default first start is the event's ZeroTime.
  - No code path writes `events.zero_time`, so every event is at the 09:00 default.
  - Consumers treat `startTime <= 0` as "no start". Starts before 09:00 become negative and fail the same filters.
- **Scenario**: the operator accepts the default 09:00:00 first start with the default stagger of 0:00. The first runner of every corridor (`optimizer.ts:390-398`) has no start time on the start screen, start lists or LiveResults.
- **Fix (M)**:
  - Reject `firstStart <= zeroTime` in `draw.execute`, or make ZeroTime settable and default it to an hour before the first start.
  - Handle pre-ZeroTime starts with a day wrap, or reject them.
  - The same collision exists in `runner.ts:121`, `:439` and `:684`.
- **Status**: confirmed (reproduced). `toRelative` was run through tsx against the real module: 324000 gives 0, and 08:30 gives −18000.

### DB-06: One duplicate punch stops the online-input (ROC) puller for good
- **Area**: online input. **Category**: stability.
- **Location**:
  - `packages/api/src/online-input/puller.ts:247-283`: per-punch create at 258-269, watermark at 248.
  - `packages/api/prisma/migrations/20260517_init/migration.sql:542-543`: `punches_oi_dedup_idx`.
  - `packages/api/src/routers/onlineInput.ts:68-70` and `:190-195`.
  - `packages/web/src/pages/EventPage.tsx:1048-1056`.
- **What is wrong**:
  - The puller runs a bare `tx.punch.create` per punch, in the same transaction that advances `lastId`.
  - Any duplicate on the partial unique index raises P2002 and rolls back the batch and the watermark. The next tick fails on the same row, forever.
  - **Trigger 1, deterministic**: the "Reset last id" button refetches from 0. Its help text (`en/event.json:224`) wrongly says "duplicates may appear".
  - **Trigger 2**: every router config write rewrites the whole JSON including `lastId`, so a config edit that overlaps a poll regresses `lastId`.
  - **Trigger 3**: two raw units mapped to one code, punched by the same card in the same second.
  - The backlog also runs in one default 5 s interactive transaction.
- **Scenario**: the operator presses Reset mid-event. All radio and online punches stop, and nothing in the UI can recover.
- **Fix (M)**:
  - Insert with `ON CONFLICT … DO NOTHING RETURNING id` (or `createMany({ skipDuplicates })`). A per-punch try/catch will not work, because Postgres aborts the transaction.
  - Journal and count only the inserted rows.
  - Chunk the backlog.
  - Make the router write per key (`jsonb_set`) and never touch `lastId` outside the reset.
  - Correct the help text.
- **Status**: confirmed (reproduced). On a private PG16 cluster, after a reset the poll failed on `punches_oi_dedup_idx`, `lastId` stayed at 0, and the new punch was not stored.

### DB-07: Online-input control mapping saved in the UI is never applied
- **Area**: online input. **Category**: functional.
- **Location**:
  - `packages/api/src/online-input/puller.ts:235`: reader. The puller parses `cfg.mapping` at `:72` but never uses it.
  - `packages/api/src/routers/onlineInput.ts:202-223`: writer.
  - `packages/api/src/online-input/mapping.ts:31-61`: the unused key.
  - UI: `packages/web/src/pages/EventPage.tsx:883-884` and `:940`.
- **What is wrong**:
  - `addMapping` writes `cfg.mapping` inside `online_input_<eventId>_config`.
  - The puller applies `loadMapping(nameId)` from `online_input_mapping_<nameId>`, which nothing writes.
  - `online-input.test.ts:206-221` seeds the unused key directly, so it cannot catch this.
- **Scenario**: the operator maps radio unit 100 to Finish and the UI shows the mapping. Punches are stored as control 100, and no radio finish is recorded.
- **Fix (S)**:
  - Use `cfg.mapping` in the puller.
  - Delete the unused helpers, keeping `applyMapping`.
  - Test through the router.
  - Unify the rawCode limit: `mapping.ts` rejects codes of 1024 and above, while the router accepts any code.
- **Status**: confirmed.

### DB-08: Eventor `sync` can mass-cancel runners and reverts desk edits
- **Area**: Eventor import. **Category**: stability / data safety.
- **Location**:
  - `packages/api/src/routers/eventor.ts:903-1211`: cancel loop at 1185-1195, results-only loop at 1144-1181, overwrite at 1033-1098, `existing` query at 958-962.
  - `packages/api/src/eventor.ts:699-701` and `:911-913`.
- **What is wrong**:
  - **(a)** Every Eventor-linked runner not in `seen` is set to Cancel, with no guard on `finishTime` (which is selected but unused) or on status. `fetchEntries` returns `[]` when a 200 response has no `EntryList`, so one empty or non-standard body cancels everyone. HTTP errors throw before any write, so they are safe.
  - **(b)** The results-only loop never calls `seen.add`, so those runners are cancelled on every later sync. This is deterministic.
  - **(c)** Name, class, card, club, birth year and sex are overwritten unconditionally. `claimCardNo` returns null when Eventor has no card, which clears a rental card set at the desk.
  - **(d)** The `existing` query lacks `removed: false`.
  - **(e)** There is no transaction and no audit trail, so earlier statuses cannot be restored.
- **Scenario**: on race morning the operator presses Sync (`EventPage.tsx:399`, no confirmation). Runners added from results are cancelled. Class moves and rental cards made at the desk are reverted. If Eventor returns an empty entry list, every imported runner, including those with results, becomes Cancel.
- **Fix (M)**:
  - Never cancel a runner with a finish or a non-Unknown status.
  - Abort when entries are empty while linked runners exist, or when the cancel ratio exceeds a threshold.
  - Add the missing `seen.add`.
  - Add `removed: false` to the `existing` query.
  - Make the fetchers throw when the root element is missing.
  - Wrap the writes in a transaction.
  - Which fields Eventor may overwrite after a local edit is a product decision. At minimum, never null a locally set card and never revert class or name.
  - Extend `eventor-reentry.test.ts`.
- **Status**: confirmed. (a) needs an unusual 200 response. (b) and (c) are deterministic.

### DB-09: LiveResults push deletes in-forest runners every cycle, runs N+1 over the WAN, and lets cycles overlap
- **Area**: LiveResults. **Category**: performance / functional.
- **Location**: `packages/api/src/liveresults.ts:401-415` (delete), `:417-501` (per-runner loop, `punch.findMany` at 475-484), `:580-593` (`setInterval`), `:609` (`pushNow`), `:596-601` (`stop`).
- **What is wrong**:
  - Each cycle deletes the remote runner, start and radio rows of every status-Unknown runner, which includes everyone in the forest. It then re-inserts them one by one, in autocommit, with no transaction.
  - Each started runner costs 3–5 sequential remote statements plus one local query.
  - `setInterval` has no in-flight guard. Once a cycle outlasts the interval (30 s by default, 5 s at minimum), the next cycle's DELETE wipes rows the previous one just re-inserted.
  - `stop()` leaves an in-flight cycle writing.
- **Scenario**: at a 2,000-runner event, one cycle is 4,000–6,000 WAN round trips, which takes minutes. Runners in the forest, and their radio splits, disappear from public LiveResults for most of the race.
- **Fix (M)**:
  - Add a per-tenant busy flag and chain `setTimeout` after completion.
  - Delete only rows whose state changed.
  - Load punches once per event.
  - Use multi-row `INSERT … ON DUPLICATE KEY UPDATE` in chunks.
  - Set `changed` only on real changes.
- **Status**: confirmed.

### DB-10: Test Lab can overwrite or hard-delete a real event's race data
- **Area**: data safety. **Category**: stability / security.
- **Location**: `packages/api/src/routers/testLab.ts:141-176` (`processSimulatedReadout`), `:243-248` (`clearRunners`), `:292-551` (`startSimulation`), `:182-240` and `:273` (public procedures); `packages/web/src/lib/shell-tabs.ts:58`; `packages/web/src/pages/TestLabPage.tsx:227-233`.
- **What is wrong**:
  - `startSimulation` overwrites `cards.punches_raw` and runner finish and status for every runner with a start time and card, using the bare client with no transaction, no journal and no check for existing results.
  - It is `manageProcedure`, so the lease guard (`assertRaceWritable`) never runs. With the default `AUTH_MODE=off`, anyone who can reach the API passes.
  - The Start button has no confirmation.
  - `clearRunners` is the only hard `runner.deleteMany` in the code. It does have a confirm.
  - The tab is offered for every event, in the More overflow.
  - `generateEvent` is a `publicProcedure` with no caller that creates up to 2,000 runners.
- **Scenario**: someone opens Test Lab on the live event and clicks Start simulation. The real readouts are replaced with fabricated punches, with no undo and no journal.
- **Fix (S–M)**:
  - Gate the router and the tab behind an env flag or a test-event marker.
  - Refuse when any runner has a real card or finish.
  - Move the mutations to `manageRaceProcedure`.
  - Confirm before Start.
  - Soft-delete in `clearRunners`.
  - Delete `generateEvent`, or make it admin-only.
- **Status**: confirmed.

### DB-11: Offline registration loses club, fee and personal data, and drops rejected entries silently
- **Area**: offline sync / registration. **Category**: functional.
- **Location**: `packages/web/src/components/RegistrationDialog.tsx:638-648`; `packages/web/src/lib/offline/db.ts:50-57`; `packages/shared/src/journal.ts:146-175`; `packages/api/src/routers/events.ts:445-524`, `:96-139`.
- **What is wrong**:
  - The offline branch emits only `{ tempId, name, classId, clubId, cardNo, startTime }`.
  - The web payload type diverges from the shared one: it sends `clubId`, while the server reads `clubName` and `eventorClubId`. Birth year, sex, phone, fee, paid, pay mode and card fee are absent.
  - When the class is not found or the card is taken, the apply falls through to `break`. The entry is journaled and marked synced, with no log line.
- **Scenario**: the browser is offline (`navigator.onLine` false) at the registration desk. Every runner registered in that window arrives clubless and unpaid. A registration whose card is already taken vanishes without a trace.
- **Fix (M)**:
  - Use the shared payload type, extended with the missing fields, and emit them all.
  - Throw from the apply on class-not-found or card-taken, so the entry lands in the station's failed list.
  - Keep the idempotent `byId` re-push a success.
- **Status**: confirmed.

### DB-12: Backup-memory punches are stored as absolute time in a ZeroTime-relative column
- **Area**: readout / controls. **Category**: functional.
- **Location**:
  - `packages/api/src/routers/control.ts:1870` (store), `:1890-1893` (journal), `:1727` (compare), `:1788` and `:1805` (`pushBackupPunch`).
  - Client: `packages/web/src/pages/ControlsPage.tsx:1678`.
  - Consumers: `routers/cardReadout.ts:187-222`, `liveresults.ts:475-488`, `packages/web/src/pages/BackupPunchesPage.tsx:226-227`.
- **What is wrong**:
  - The client sends seconds-since-midnight × 10 (`si-protocol.ts:1602`). The server stores it unconverted in `punches.time`, which is documented as ZeroTime-relative. Every other writer calls `toRelative`.
  - Readout picks these punches up with no source filter, and LiveResults uses them for radio splits.
  - The journal applies `toAbsolute` to the already-absolute value. Past 24 h, `timeConvert.ts:26` wraps it and nodes diverge.
  - `listAllBackupPunches` compares a relative finish time with an absolute punch time.
- **Scenario**: with ZeroTime at 09:00, a punch at 10:15 recovered from a control's backup memory is read as 19:15. The runner's split is wrong, or the punch does not match. Start and finish backup punches always show `time_mismatch`.
- **Fix (S–M)**:
  - Store `toRelative(p.punchTime, zeroTime)` and journal the absolute input.
  - Return absolute values from `listAllBackupPunches`, and convert in `BackupPunchesPage`.
  - Run a one-off correction of existing `source='backup_memory'` rows and their `manual` mirrors.
  - Add a regression test with a non-zero ZeroTime. No test covers these procedures today.
- **Status**: confirmed.

### DB-13: Event backup dumps a table that no longer exists and hides every psql error
- **Area**: backup. **Category**: stability.
- **Location**: `packages/api/src/backup.ts:151` (`"event_log"`), `:194`, `:203-208`, `:243-257`, `:301-309`; `docs/ops/backup-restore.md:7` and `:18`.
- **What is wrong**:
  - `event_log` was renamed to `journal` in `20260601130000_journal_rename`, so its section is always empty.
  - psql runs without `ON_ERROR_STOP` and exits 0. The `-- BACKUP FAILED` trailer only fires on a non-zero exit, and stderr is dropped.
  - Any future table or column rename in a core table will silently empty that section too.
  - The 23 `\copy` statements run in separate transactions, so a dump taken during readout is not a consistent snapshot.
  - The tests (`integration/backup.test.ts:147`, `e2e/backup.spec.ts:86`) assert only the absence of the trailer, which an exit 0 always satisfies.
- **Scenario**: the operator downloads a backup during the race. It looks complete, but the journal is missing, and any other failed section would be missing just as quietly.
- **Fix (S)**:
  - Rename the entry to `journal`.
  - Pass `-v ON_ERROR_STOP=1` and log stderr whenever it is non-empty.
  - Wrap the script in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; … COMMIT;`.
  - Add a test that every `BACKUP_TABLES` name exists and has a header row.
  - Correct the doc.
- **Status**: confirmed (reproduced). On a private PG16 cluster, the same script shape printed the error, continued, and exited 0 with an empty section. The verifier rated this medium because the doc already admits the journal gap. It is kept high because the silent-failure mechanism applies to every table.

### DB-14: The documented event restore cannot succeed for an event with readouts
- **Area**: backup / schema. **Category**: stability.
- **Location**: `packages/api/src/backup.ts:124-161` ("FK-safe restore order") and `:80`; `docs/ops/backup-restore.md:18`, `:65`, `:90-97`.
- **What is wrong**:
  - **Order**: `runners` comes before `cards` (`runners.card_id`, init `:392`), `cards` before `card_readouts` (`cards.readout_id`, `:366`), and `punches` before `control_units` (`punches.unit_id`, `:530`). None of these FKs is deferrable.
  - **Missing tables**:
    - `map_templates` is not dumped, but `classes.sheet_template_id` references it (`20261103120000_auto_templates:38-40`).
    - `card_readout_backups`, `event_permissions` and `map_colour_settings` are absent and not mentioned in the doc.
    - `course_maps`, `graphics`, the journal and the lease tables are admitted gaps.
  - **No tool**: there is no restore tool for race data (step 6, "no committed helper"), yet the doc ends with "all data intact".
  - **Column order**: the dump is `SELECT *`, loaded by position. Step 1 says `pnpm db:push`, whose column order differs from a migrated database (for example `classes.print_scale`), while `backup.ts:80` says to migrate.
  - **Event row**: step 6 loads `events.csv` again and collides on `name_id`.
- **Scenario**: the database is lost on race day and the operator follows the doc. `\copy runners` fails on `runners_card_id_fkey` for everyone who has read out, `classes` fails on the template FK, and `controls` misaligns.
- **Fix (M–L)**:
  - Commit `restore-event.sql` or `.ts`. It should load each section through a temp table, map columns by header name, rewrite `event_id`, and insert in real FK order: `card_readouts → cards → runners`, `control_units → punches`, `map_templates → classes`.
  - Add the missing tables to the dump.
  - Change step 1 to `pnpm db:migrate`.
  - Add an integration round-trip test with runners, cards, readouts and punches.
- **Status**: confirmed. The verifier rated it medium because the doc admits part of it. It is kept high because the per-event download is the only recovery path for an arena laptop (see DB-36).

---

## Medium

### DB-15: Journal ingest applies an entry and journals it non-atomically
- **Area**: offline sync. **Category**: stability.
- **Location**: `packages/api/src/routers/events.ts:97-142`, `:756-793` (`card.read` dedupe, with the comment at `:790` admitting it), `:893-934`; `packages/api/src/routers/cardReadout.ts:516-592`.
- **What is wrong**:
  - `storeReadoutImpl` runs outside a transaction on this path: readout create, then the card upsert, then the runner link.
  - The journal insert is a separate commit.
  - Any exception between the readout create and the runner link (a connection blip or a pool timeout, not only a crash) is reported as failed and retried. The ±60 s dedupe then finds the orphan readout row and skips, and the entry is marked synced.
  - `applyReferenceUpsert` replaces course controls and class pools in three commits.
- **Scenario**: a station drains its outbox and one readout hits a DB error mid-store. `cards.punches_raw` and the runner link are never written. The runner has no result, and the station has cleared its copy.
- **Fix (M)**:
  - Wrap each entry's apply and journal insert in one `$transaction`. The helpers already take a `tx`.
  - Move the Sheets push and follow-ups to after commit.
- **Status**: confirmed. Verifier: medium, borderline high, because the failure is silent.

### DB-16: `importCourses` with "replace all" wipes the event outside a transaction
- **Area**: courses. **Category**: stability.
- **Location**: `packages/api/src/routers/course.ts:1884-1899` (wipe), `:1932-2246` (per-row writes), `:2296-2303` (the comment accepting this), `:2308-2360` (journal at the end); `packages/web/src/components/CourseImportDialog.tsx:30` (`replaceAll` defaults to true).
- **What is wrong**:
  - Three autocommit statements soft-delete all courses and controls and null every `class.course_id`.
  - Hundreds of sequential writes follow, and the journal entry comes last.
  - The comment's claim that "a crash in between loses only the ship" is wrong for `replaceAll`.
- **Scenario**: a course re-import on the event morning fails midway. The event has no live courses or controls and no class has a course, so readout has nothing to match. A retry relinks classes only if `classMapping` is sent again.
- **Fix (M)**:
  - Run the body in one `$transaction` with an explicit timeout (60–120 s), passing `tx` to the helpers.
  - Replace the nested `$transaction` calls at 2066 and 2094 with the outer `tx`.
  - Fix the comment.
  - Add a failure-atomicity test.
- **Status**: confirmed. File parsing runs before the wipe, so a bad file is refused cleanly. A mid-run failure is not.

### DB-17: Deleting a course leaves classes and runners on it, and readout keeps judging against it
- **Area**: courses / readout. **Category**: functional.
- **Location**: `packages/api/src/routers/course.ts:1197-1215`; readers at `routers/cardReadout.ts:196-207` and `:633-637`, `routers/race.ts:39-45`, `routers/classRouter.ts:51-58` and `:137-138`.
- **What is wrong**:
  - `course.delete` only sets `removed`.
  - `class.course_id` and `runner.course_id` still point at the removed course, and the readout lookups have no `removed` check.
  - `course.list` and LiveResults hide the course, so the two views disagree.
- **Scenario**: the organiser deletes course A and creates a replacement but forgets to relink the class. The class page still says A, and readout marks runners MP against the old controls with no warning.
- **Fix (S–M)**:
  - Refuse with CONFLICT while live classes or runners reference the course, listing them.
  - Alternatively, null the references in the same transaction and journal them.
- **Status**: confirmed. Raised from the verifier's low to medium, because the outcome is a wrong result in readout.

### DB-18: Lease checkout wipes unshipped local entries, and a local lease can become impossible to release
- **Area**: offline sync / lease. **Category**: stability.
- **Location**: `packages/api/src/routers/lease.ts:141-169` and `:249-250`; `packages/api/src/sync/lease.ts:319` and `:122-127`; `docs/system/offline-architecture.md:249`.
- **What is wrong**:
  - Checkout runs `event.deleteMany({ nameId })`, which cascades to the journal and watermarks. It never checks whether local entries are unshipped, although the doc requires the venue to be fully shipped first.
  - After a cloud `forceTakeover`, checkin calls `peer.release` first, which throws "No active lease". The box's local lease is therefore never released: the box keeps accepting race writes while the cloud also writes, and the UI offers no way out.
- **Scenario A**: a box that checked in earlier takes offline registrations, and the operator presses Checkout before the shipper drains. Those entries are deleted. A blocked stream (`shipper.ts:281`) is the worst case, because everything behind the poison entry is wiped.
- **Scenario B**: the cloud takes over from a box it thinks is dead. The box comes back and two nodes write the same event.
- **Fix (S–M)**:
  - In checkout, ship first and refuse when `pendingPush > 0`, with an explicit `discardLocal` override for a dead box.
  - In checkin, treat the peer's "no active lease" or "held by another" as already released and release locally.
  - Add two integration tests.
- **Status**: confirmed. The forceTakeover-then-checkout path is reachable only through the API (`VenueLease.tsx:124`). Scenario A is reachable through the UI.

### DB-19: Result list gives tied runners sequential places
- **Area**: results. **Category**: functional.
- **Location**: `packages/api/src/routers/lists.ts:181-213` (`entry.place++` at `:200`); `packages/web/src/pages/ResultsPage.tsx:33` and `:143-145`.
- **What is wrong**:
  - `resultList` numbers places 1, 2, 3 regardless of ties.
  - `computeClassPlacements` (`packages/shared/src/results.ts:100-130`, used for the Eventor export) and `race.finishReceipt` share places on a tie.
  - SI times are whole seconds, so ties happen at large events.
  - `resultList` also ignores `Class.noTiming`.
  - `finishReceipt` skips the running-time adjustment that `resultList` applies.
- **Scenario**: two runners at 10:00 are shown as 1 and 2 on the results page, but both as 1 on their receipts.
- **Fix (S–M)**:
  - Use `computeClassPlacements(runners, cls.noTiming)` with the adjustment and a deterministic tie-break.
  - Add an integration test covering a tie, a no-timing class and an adjusted runner.
- **Status**: confirmed (reproduced). A node mirror of both loops gives 1,2,3 against 1,1,3. Raise to high if the screen is used for prize-giving.

### DB-20: Eventor `importEvent` can leave a partial event that cannot be retried
- **Area**: Eventor import. **Category**: stability.
- **Location**: `packages/api/src/routers/eventor.ts:694-730` (event transaction) and `:731-856` (unguarded writes); `packages/api/src/routers/event.ts:328-331`; `packages/web/src/pages/CompetitionSelector.tsx:900-902`.
- **What is wrong**:
  - The event row commits first. Classes, clubs and runners follow one at a time, with no transaction or cleanup.
  - A retry hits `nameId @unique` as a raw P2002 500, because there is no pre-check, unlike `event.create`.
  - Deleting the partial event does not help, because the soft delete keeps the slug.
- **Fix (M)**:
  - Add a CONFLICT pre-check that handles soft-deleted rows.
  - Do the DB writes in one transaction with `createMany` and an explicit timeout, keeping the Eventor network calls outside it.
- **Status**: confirmed.

### DB-21: `draw.execute` is one transaction per runner, journals no start numbers, and restarts numbering
- **Area**: draw. **Category**: stability / functional.
- **Location**: `packages/api/src/routers/drawRouter.ts:133`, `:160-197` (payload at `:176-180`); `packages/api/src/draw/drawEngine.ts:227`; `packages/api/src/routers/events.ts:430-442`.
- **What is wrong**:
  - Each runner is its own transaction, so a failure midway leaves the draw half-applied. Execute re-runs the random preview, so a retry produces a different order.
  - `start.adjusted` carries no `startNo`, so peers never get start numbers.
  - `globalStartNo` starts at 1 on every execute. Drawing a subset of classes is a normal UI path (`DrawPanel.tsx:168-170`), so start numbers and bib fallbacks are duplicated.
- **Fix (M)**:
  - Run the execute in one transaction, with batched journal appends.
  - Add `startNo` to the payload and apply it when present.
  - Seed numbering from the event's maximum start number outside the drawn classes.
  - Pass the previewed result or a seed into execute.
- **Status**: confirmed.

### DB-22: Changing a runner's card number leaves the old card linked
- **Area**: registration / readout. **Category**: functional.
- **Location**: `packages/api/src/routers/cardReadout.ts:176-184` (`performReadout` prefers `cardId`), `:1247-1250` (unlink); `packages/api/src/routers/runner.ts:80` (`buildRunnerUpdateData`); `packages/api/src/routers/events.ts:527-553` (replay); `packages/api/src/routers/eventor.ts:1612`.
- **What is wrong**:
  - `runner.update`, unlink and the `runner.updated` replay change `cardNo` but not `cardId`. Link does reset it.
  - Readout, receipts, `race.ts` and the Eventor split export keep the old card's punches. The free punches are looked up by the new number, so the result mixes the two cards.
  - If the new card was read before the edit, nothing ever relinks it.
  - Link (`:1273-1281`), create (`runner.ts:420` vs `:425`) and update (`:531` vs `:563`) also surface the partial unique index as a raw 500 rather than CONFLICT.
- **Fix (S–M)**:
  - In `buildRunnerUpdateData` and unlink, re-resolve `cardId` to the live card with the new number, or null it.
  - Map P2002 on `runners_event_id_card_no_key` to CONFLICT.
- **Status**: confirmed.

### DB-23: `cardDetail` reads the wrong JSON shape
- **Area**: readout. **Category**: functional.
- **Location**: `packages/api/src/routers/cardReadout.ts:1122-1140` and `:1165-1171`; writer at `:393-403` and `:516-521`; `packages/web/src/pages/CardsPage.tsx:672-730`.
- **What is wrong**:
  - The reader expects `{ type, time }`. Live rows hold `{ controlCode, time }`, and migrated or showcase rows hold `{ raw: "…" }`.
  - As a result, the control column in the Cards drawer is blank, start, finish and check are always null, and migrated cards show "no readout data". The history list below renders correctly.
- **Fix (S–M)**:
  - Read `controlCode`.
  - Take check, start and finish from `cards.punches_raw`, converting from relative.
  - Parse the `{raw}` shape.
  - Add a test.
- **Status**: confirmed. This is display only.

### DB-24: Unauthenticated endpoints expose personal data and use the stored Eventor key
- **Area**: Eventor / auth. **Category**: security.
- **Location**:
  - `packages/api/src/routers/eventor.ts:582`, `:604`, `:630`, `:1220` (`syncRunnerDb`, a mutation), `:1363-1484` (`searchRunnerDb`, `lookupByCardNo`, `clubMembers`, `runnerDbDump`) and `:1898` (`fetchEntryHistory`).
  - `routers/registrationTrends.ts:131`, `:174`, `:242`, `:305` and `:321`.
  - `routers/clubRouter.ts:222`.
  - `routers/event.ts:767`.
- **What is wrong**:
  - These are `publicProcedure`, which does no auth even with `AUTH_MODE=proxy`.
  - They return names, birth years and card numbers for the whole directory, or trigger Eventor calls and cache writes with the stored API key.
  - Deactivated users are not locked out of them, contrary to `docs/system/authentication.md`, step 6.
- **Fix (S)**:
  - Move the mutations and Eventor-key callers to `authedProcedure`, with `syncRunnerDb` going to admin.
  - `runnerDbDump`, `searchRunnerDb` and `lookupByCardNo` are used by the kiosk (`useStationSync.ts:37`, `:69`), so they need a kiosk-key-or-user gate rather than a plain switch.
- **Status**: confirmed. This matters only under `AUTH_MODE=proxy`; the documented deploy is IAP-fronted. It likely overlaps the auth area.

### DB-25: `club.detail` with id 0 returns every runner in the event
- **Area**: clubs. **Category**: functional.
- **Location**: `packages/api/src/routers/clubRouter.ts:70-77` and `:88-104`; `packages/web/src/pages/ClubsPage.tsx:120-122`, `:193` and `:205`.
- **What is wrong**:
  - `club.list` gives every free-text club `id: 0`.
  - `detail({ id: 0 })` adds no club filter, so it lists all runners and takes its name from an arbitrary one.
  - All free-text clubs share one React key and expand together.
- **Fix (S–M)**:
  - Give free-text clubs a name key and call the existing `getById({ name })`.
  - Return NOT_FOUND for `id <= 0`.
- **Status**: confirmed.

### DB-26: Creating an event with the slug of a deleted event returns a raw 500
- **Area**: events. **Category**: functional.
- **Location**: `packages/api/src/routers/event.ts:255-265` and `:328-331`.
- **What is wrong**:
  - The pre-check only rejects live rows.
  - The create then hits `nameId @unique`, and the error formatter (`trpc.ts:100`) passes P2002 through as INTERNAL_SERVER_ERROR.
  - It stays broken until an admin runs `purgeDeleted`.
- **Fix (S)**: return CONFLICT naming the deleted event, or rename the slug on soft delete. Also catch P2002 on create.
- **Status**: confirmed.

### DB-27: Replacing an event's map drops the working pin before the new import succeeds
- **Area**: map store. **Category**: stability.
- **Location**: `packages/api/src/event-map.ts:139-156`; `packages/api/src/map-store/event-document.ts:56-63`; callers at `routers/course.ts:1544` and `:1619`.
- **What is wrong**:
  - All `map_files` rows are deleted and an unpinned row is created, with no transaction, before the job starts.
  - Until the job pins, readers see no map: printing, `loadEventCrs` and the patch.
  - If the import fails or hits the 10-minute timeout, the old pin, `rotationCorrection` and `clubMapVersionId` are gone.
  - The old bytes survive for 30 days (`gc.ts:23`), so re-applying the old file restores the map quickly, but only if the organiser still has it.
- **Fix (M)**:
  - Keep the old row until `applyJobResult` pins the new one, and swap the rows in one transaction there.
  - Have `eventPin` prefer the newest pinned row.
  - On failure, delete the unpinned new row.
- **Status**: confirmed.

### DB-28: A map import that kills the process is re-claimed after every restart
- **Area**: map store. **Category**: stability.
- **Location**: `packages/api/src/map-store/jobs.ts:198-217` and `:504-513`; `schema.prisma:1551-1579`. Compare `map-store/dem-jobs.ts:220-231` and `:262-265`.
- **What is wrong**:
  - A stale `running` import job is re-claimed with no attempt counter.
  - The DEM engine has exactly this guard (`failExhausted`, "it took its instance down every time"). The import engine does not.
  - Worker errors and worker OOM are caught, so the loop needs whole-process death: a cgroup OOM on a huge map, a native crash, or a failure in the main-thread stages (`jobs.ts:236-248`).
- **Scenario**: with `restart: unless-stopped`, the API dies every one to two minutes, taking registration and readout down with it. The only way out is a manual DB edit.
- **Fix (S–M)**:
  - Add `attempts INT DEFAULT 0` and increment it in `claim`.
  - Fail stale rows with `attempts >= 3` before claiming, mirroring the DEM engine.
  - Update `docs/map-storage.md` §6.
- **Status**: confirmed (the guard is missing); the trigger is plausible.

### DB-29: Start auto-names can repeat, and courses resolve starts by name
- **Area**: courses / controls. **Category**: functional.
- **Location**: `packages/api/src/routers/control.ts:790-798`; `packages/api/src/course-structure.ts:60` and `:243-259`; `packages/api/src/routers/course.ts:401-402`, `:496-500` and `:906-917`.
- **What is wrong**:
  - A new start is named `Start ${count + 1}`, so after deleting "Start 1" of two, the new start is "Start 2" again.
  - Any course save from the Courses page sends `controlIds` (`CoursesPage.tsx:803`, `:1065`). That rebuilds the structure from columns, where the start is found by name, so the older "Start 2" wins.
- **Scenario**: a course on the new Start 2 silently moves to the old one on its next save. The length, first leg and printed start triangle are then wrong.
- **Fix (S–M)**:
  - Pick the lowest free N inside the create transaction, and reject a duplicate live start name on create and update.
  - Keep the start's site id across `rewriteStructureFromColumns`.
- **Status**: confirmed.

### DB-30: Club map download sends the whole file base64 in a tRPC response
- **Area**: map store. **Category**: performance.
- **Location**: `packages/api/src/routers/clubMap.ts:237-268`; `packages/web/src/pages/SettingsPage.tsx:423-435`; `routers/course.ts:1287-1310` (`downloadMap`, which has no web caller).
- **What is wrong**:
  - Uploads may be up to 128 MiB. Base64 adds a third, so a source over about 24 MiB exceeds Cloud Run's 32 MiB response ceiling (`docs/map-storage.md:297`).
  - This contradicts AGENTS.md pitfall 8.
  - A streamed, ranged route already exists: `GET /api/map-sources/:hash`.
- **Fix (S–M)**:
  - Point the Settings button at the ranged route, after checking that its auth matches.
  - Delete `clubMap.download` and `course.downloadMap`.
- **Status**: confirmed.

### DB-31: `prisma db push` is documented, but the database it builds cannot run the app
- **Area**: schema. **Category**: engineering / stability.
- **Location**: `README.md:137`; `AGENTS.md:33`; `docs/ops/backup-restore.md:64-65`; `scripts/load-showcase.sh:44`, `:104-105` and `:120-122`; `packages/api/package.json:23`; `packages/api/prisma/schema.prisma:553`.
- **What is wrong**: several objects exist only in migration SQL:
  - the `allocate_event_seq` and `set_updated_at` triggers;
  - five partial unique indexes, among them one card per event and one active lease per event;
  - 36 CHECKs;
  - the seeded `permission_groups`.

  Separately, `schema.prisma:553` says `onDelete: Restrict` for `course_controls.control_id`, while `20260521_course_controls_cascade` made it CASCADE.
- **Scenario**:
  - A from-source install that follows the README fails on the second runner of every event, because every row gets `seq` 0. It also accepts duplicate cards.
  - The restore doc tells the operator to run `db push` against an already-migrated database. That would revert the FK to RESTRICT.
  - Release, venue and GCP installs all run `migrate deploy` and are unaffected.
- **Fix (S)**:
  - Replace every documented `db:push` with `db:migrate`, and remove or fence the script.
  - Fix `schema.prisma:553`.
  - List the SQL-only objects in a comment block in the schema.
- **Status**: confirmed.

### DB-32: Venue box has no working migrate step and no check for an unmigrated database
- **Area**: deploy. **Category**: stability.
- **Location**: `docs/ops/venue-runbook.md:33-35` and `:53`; `docker-compose.venue.yml:17-19`; `Dockerfile:18` and `:66`; `packages/api/src/index.ts:101`.
- **What is wrong**:
  - The runbook's `exec api pnpm … prisma migrate deploy` fails, because `pnpm` exists only in the `deps` stage and there is no `corepack enable`.
  - The venue and default compose files have no `migrate` service, unlike `docker-compose.release.yml:31-43`.
  - `/health` does not touch the database, so runbook step 5 passes on an unmigrated box.
  - There is no upgrade section in the runbook.
- **Scenario**: a box rebuilt with new code over an existing volume, where the operator skips the failing step. The first query on a new column fails mid-event.
- **Fix (S–M)**:
  - Add the release file's `migrate` service, with `depends_on: service_completed_successfully`.
  - Fix the runbook command and add an upgrade section.
  - Add a `/ready` that runs `SELECT 1` and a pending-migration check.
- **Status**: confirmed. The failure is loud at setup time. Docker was not run.

### DB-33: Release compose always pulls a floating `stable` image and migrates without a backup
- **Area**: deploy. **Category**: stability.
- **Location**: `docker-compose.release.yml:32-33`, `:43` and `:46-47`; `docs/releases/README.md:160-161`; `README.md:95-98`.
- **What is wrong**:
  - `pull_policy` defaults to `always` on `ghcr.io/…:stable`, and every `up` runs `migrate deploy` with no dump first.
  - With the registry unreachable, `up -d` fails even when the image is cached.
  - A plain reboot is safe (`restart: unless-stopped`). An operator running `up -d` at the arena is not.
- **Fix (S)**:
  - Default the pull policy to `missing`.
  - Lead the docs with a pinned tag, and describe upgrading as `pull`, then `pg_dump`, then `up`.
  - Check `scripts/__tests__/release-compose.test.mjs`.
- **Status**: confirmed. The offline-pull behaviour comes from the Compose source and docs; it was not run.

### DB-34: `cards` has no unique (event, card number), so a retried readout can create a twin card
- **Area**: schema / readout. **Category**: stability.
- **Location**: `packages/api/prisma/schema.prisma:914-915`; init `:376`; `packages/api/src/routers/cardReadout.ts:556-580` and `:1577-1593`; `routers/lists.ts:109-120`; `routers/course.ts:1463-1471`; `cardReadout.ts:997`.
- **What is wrong**:
  - `storeReadoutImpl` does `findFirst`, then `create`, with no lock, under READ COMMITTED.
  - A realistic overlap exists: a client timeout on `storeReadout` falls back to an outbox `card.read` (`DeviceManager.tsx:362-417`) while the server is still processing.
  - The live path has no dedupe. The drain's dedupe is itself check-then-act.
  - Per-runner readout self-heals through the `runner.cardId` relink. `lists.ts` and `course.ts` build `Map(cardNo → punchesRaw)` from an unordered query, and `cardList` lists the card twice.
- **Fix (M)**:
  - Add a migration that merges duplicates, then a partial unique index on `(event_id, card_no) WHERE removed = false`.
  - Use `INSERT … ON CONFLICT DO UPDATE`, or catch P2002 and retry as an update.
  - Use `readCount: { increment: 1 }`.
  - Add `orderBy: { updatedAt: "asc" }` to the two map builders.
- **Status**: confirmed (the constraint is missing); the race is plausible.

### DB-35: Cloud SQL is provisioned without point-in-time recovery
- **Area**: deploy. **Category**: stability.
- **Location**: `scripts/gcp/provision.sh:30-40`; `docs/ops/deploy-gcp-cloud-run.md:295-301`.
- **What is wrong**: only the 03:00 daily backup and the release-time on-demand backups exist.
- **Scenario**: a bad write or an accidental `purgeDeleted` at 14:00 on race day can only be restored to 03:00.
- **Fix (S)**:
  - Add `--enable-point-in-time-recovery --retained-transaction-log-days=7`, plus an idempotent `instances patch` outside the create guard. The patch restarts the instance, so never run it on race day.
  - Document the `clone --point-in-time` restore.
- **Status**: confirmed from the script. Whether someone enabled PITR by hand on the live instance was not checked: `gcloud sql instances describe … pointInTimeRecoveryEnabled` settles it.

### DB-36: Arena laptops have no automated backup
- **Area**: deploy / backup. **Category**: stability.
- **Location**: `docker-compose.venue.yml` and `docker-compose.release.yml` (no backup service); `docs/ops/backup-restore.md`.
- **What is wrong**: the only backup of a self-hosted or venue database is the operator-triggered per-event download, which is incomplete (DB-13, DB-14).
- **Scenario**: disk failure on the arena laptop loses everything since the last manual download.
- **Fix (S–M)**: add a `pg_dump --schema=oxygen` sidecar on a timer to a separate volume or USB path, and document it.
- **Status**: confirmed by the absence, noted by the DB-35 verifier. This is a gap, not a bug.

---

## Low

| ID | Title and location | Fix (size) | Status |
|---|---|---|---|
| DB-37 | `tracks.deleteRoute` deletes by id with no event check (`routers/tracks.ts:81`). Nothing on main writes `routes`, so rows exist only from restore or legacy data. An unknown id gives P2025 as a 500. The header comment at `:4` is stale. | `deleteMany({ id, eventId })`, NOT_FOUND on count 0, and a cross-event test (S) | confirmed |
| DB-38 | Backup-memory import has no dedup: fresh uuids, and the only unique index is for `online_input` (`routers/control.ts:1862-1898`). Re-reading a station doubles every punch on the origin. Replicas dedupe, so the nodes diverge. `pushBackupPunch` (`:1765-1811`) does not check `isOriginal`. | Pre-filter on `(event, card, code, time, source)`, one `journalEntry.createMany`, and `updateMany where isOriginal` as the guard (S–M) | confirmed |
| DB-39 | Bulk mutations do per-row work in transactions with the default 5 s timeout and unbounded `ids` (`routers/runner.ts:689-713` `bulkUpdate`; `:620-636`; `classRouter.ts:384-394`, `:462-476`). Only a select-all class change on a large event is near the limit. | `{ timeout: 60_000 }` as elsewhere in the repo, `journalEntry.createMany`, `.max()` on `ids` (S) | plausible |
| DB-40 | Dedup import path marks the job `done` before `applyJobResult` (`map-store/jobs.ts:431-438`). A throw there leaves the event unpinned, with the job saying done. `pnpm map:rematch` repairs it. The pin writes at `:303-307` are not in a transaction on either path. | Insert as `running`, apply, then mark done; wrap the pin writes in a transaction (S) | confirmed |
| DB-41 | `control.list` loads `course_controls` of every event in the database (`routers/control.ts:591-593`). | `where: { course: { eventId, removed: false } }` (S) | confirmed |
| DB-42 | `tracks.listRoutes` fetches every route's waypoints JSON and discards it (`routers/tracks.ts:15-22`). `getClassRoutes` (`:121-150`) has no caller. | Explicit `select`; delete `getClassRoutes` (S) | confirmed |
| DB-43 | `club.list`, `searchDirectory` and `logoMap` load logo PNG bytes only to drop them or test existence (`routers/clubRouter.ts:51-55`, `:225-230`, `:257-261`; also `eventor.ts:452-455`). `logoMap` runs on every page with logos. | `select` scalars; filter `smallLogoPng: { not: null }` (S) | confirmed |
| DB-44 | Whole-event reads on hot paths: `runner.list` always runs `punch.groupBy` (`runner.ts:357-361`); `class.list` counts runners in JS and runs a dead `courseControl.groupBy` (`classRouter.ts:113-135`, `void controlCountMap`); `cardList` loads every readout's punches JSON (`cardReadout.ts:1026-1042`); `controlCompletionStatus` loads `punches_raw` for every card every 15 s and counts removed courses (`course.ts:1397-1522`); `controlSeqToId` loads all controls once per id (`course.ts:275-297`, callers at `:603`, `:837`). | Conditional groupBy; `groupBy _count`; `distinct` + `jsonb_array_length`; `removed: false` + short cache; one batched lookup (S each) | confirmed |
| DB-45 | `addPunch` finds the control with `codes contains "31"`, which matches "131" and "310" (`cardReadout.ts:1306-1313`). The stored `controlId` is wrong, but nothing reads it for manual punches. | `OR: codesHolding(code)` from `control.ts:340-346` (S) | confirmed |
| DB-46 | `assertCodeFree` runs outside the create and update transactions, with no lock for explicit codes (`control.ts:780`, `:936`). Concurrent creates can duplicate a code. | Check inside the transaction after the `control-codes:<eventId>` advisory lock (S) | confirmed |
| DB-47 | `punch.recorded` apply hard-codes `source: "card"` and drops `isOriginal` and `controlId` (`events.ts:616-625`). Nodes diverge on those columns. | Carry `source` and `isOriginal` in the payload, with an allow-list (S) | confirmed |
| DB-48 | `class.firstStart` units are inconsistent. The draw stores it relative (`drawRouter.ts:192`), class create and update store it raw (`classRouter.ts:217`, `:329`, `:376`), and class detail returns it raw (`:90`), so `ClassesPage.tsx:919-920` shows "1:00:00" for an 11:00 first start. | `toRelative` on write, `toAbsolute` in the DTO, plus a round-trip test (S) | confirmed |
| DB-49 | Club-wide rows: `clubMap.setRotation` is commented "ops-only, not in the UI" but open to every member (`clubMap.ts:146-153`); `mapTemplate.deleteClub` (`:398`) has no creator-or-admin rule, unlike `clubMap.remove`. Deleting a club graphic used by other events (`graphics.ts:160-174`) matches the documented behaviour (`docs/course-maps.md:168-170`) but gives no usage warning. | `adminProcedure` for `setRotation`; a creator-or-admin rule for `deleteClub`; optionally a usage check on graphic delete, which needs a spec change first (S) | confirmed |
| DB-50 | Map store moves whole files needlessly: `storeImportedDocument` re-sends up to 128 MiB of source bytes on a guaranteed no-op insert (`map-store/documents.ts:66-76`); upload finalise makes three copies (`upload-routes.ts:158-170`). | Skip the insert when the row exists; drop the `Uint8Array.from` copies (S) | confirmed |
| DB-51 | FKs with `ON DELETE SET NULL` have no index on the referencing column: `runners.card_id`, `runners.course_id`, `cards.readout_id`, `punches.unit_id`, and the event-led-only `runners.class_id`, `punches.control_id`, `routes.runner_id` (init `:366`, `:391-392`, `:530`). An event delete then scans the table per row, inside the 60 s re-checkout transaction (`sync/lease.ts:364`). | One additive migration with partial `WHERE col IS NOT NULL` indexes (S) | confirmed (not measured) |
| DB-52 | Migration and doc drift: `20260601120000_runner_card_no_nullable:33` drops a misnamed index, so `runners_event_card_idx` survives; `AGENTS.md:215` cites a non-existent `20260514_initial_pg_schema`; `AGENTS.md:132` and `docs/architecture.md:40`, `:89-91` still say `event_log`; nothing in CI compares `schema.prisma` with the migrated DB, which is how the FK drift in DB-31 went unnoticed. | New migration dropping the old index; doc fixes; optional CI `prisma migrate diff` with a shadow DB and an allowlist for the SQL-only objects (S; M for CI) | confirmed |
| DB-53 | **PR254**: the climb recompute, awaited in `eventProcedure` (`trpc.ts:175-176`), reloads `chosenLegRoutes` and the start/finish controls inside the per-course loop (`course-climb.ts:108-128`). The auto-route refresh starts a fresh worker per 20 pairs and clones and decodes the document each time (`leg-routes-auto.ts:134`, `:175-189`); the workers run one after another, not in parallel. `clearComputedClimbs` (`course-geometry.ts:321-327`) emits no journal entry, so peers keep a stale climb, contrary to `docs/course-elevation.md` §6 ("journals it twice"). | Hoist the event-wide reads, keeping the per-course lock the spec requires; one long-lived worker per refresh with a transfer list; emit `course.upserted` for the cleared ids (S each) | confirmed |

---

## Clean

- **Columns**: migrations and `schema.prisma` agree on every table, column, nullability and default. Relations and indexes drift; see DB-31 and DB-52.
- **Migration ordering**: names sort correctly. PR254's `20261122*` sort after main's last migration, and PR254's three migrations are additive.
- **Destructive migrations**: the E5 drops and F12 have data guards and documented backups. The runbook takes an on-demand Cloud SQL backup before deploy.
- **Event scoping in the schema**: every event table has `event_id … ON DELETE CASCADE`, and every unique constraint is event-scoped.
- **Event scoping in course and map data access**: `courseMap`, `mapTemplate` (event rows), `courseObject`, `layout`, `mapTrack`, `mapPatch` and PR254's `legRoute` all filter on `ctx.event.id`. The only misses found are DB-37 and DB-04.
- **Raw SQL**: every `$queryRaw*` and `$executeRaw*` in scope binds its parameters and interpolates only constant identifiers. No injection.
- **Map store transactions**: the GC re-checks references per row, with RESTRICT FKs behind it. Patches and promote lock rows and clean up on failure. DEM jobs have stale re-claim, back-off and a crash-loop guard.
- **Course writes**: `course.update`, `setStructure`, `clone`, `control.update` and `control.delete` each run in one transaction with the journal emit.
- **Other modules**: `leader.ts`, `runner-directory-sync.ts`, `statusConvert.ts`, `permissions.ts`, `results.ts`, `sync/mapRefresh.ts`, `settingsRefresh.ts`, `venueForwarder.ts`, `ownership.ts` and `nodeIdentity.ts` showed no data-access defects.

## Dropped after verification

- **`leg_routes` lacks a `set_updated_at` trigger (PR254)**: refuted. Every writer goes through Prisma `@updatedAt`, and 14 other tables have no trigger either.
- **Init migration cites a missing `docs/schema.md`**: true, but editing an applied migration changes its checksum. Not worth a fix.
- **Club-wide control series, class presets and club map rename open to every member**: documented policy (`docs/system/club-library.md:8-9`, `:67-68`, `:148`). Only the residual items in DB-49 remain.
- **`cardReadout.ts:1246-1259` as a bulk timeout risk**: it touches one or two rows.
- **PR254: leg routes edited at the venue never return at checkin**: true, but listed in `docs/course-elevation.md`'s Pending section (`:1348-1349`, and decision 19 at `:92-93`). It is a known limitation. The cheapest fix, if wanted, is to make `legRoute.` cloud-owned in `packages/shared/src/cloud-ownership.ts`.

## Not reviewed, or could not be verified

- **Runtime checks not run**: nothing ran against a migrated database. `prisma migrate diff` was not run (no shadow DB), and index names and `ON UPDATE` actions were compared by eye only. The four reproductions used hand-built minimal schemas on a throwaway PG16, not the full migration chain. Docker, Compose and the GCP scripts were read, not run.
- **Live state**: whether production or the dev database actually has the SQL-only triggers and partial indexes, and whether PITR is enabled on the live Cloud SQL instance, could not be checked.
- **Data rewrites**: data migrations already applied in production (`20261109120000_map_anchored_objects_to_course_objects` and the other map and layout rewrites) were read, but not checked against the app's zod schemas.
- **Not read**: `sync/snapshotMaps.ts`, `snapshotGraphics.ts`, `googleIdToken.ts`, `draw/optimizer.ts` and `algorithms.ts` (except the corridor phase used in DB-05), `online-input/protocol.ts`, and the body of `routers/registrationTrends.ts`.
- **Partly read**:
  - `routers/event.ts` lines 470–540 and 800–1032;
  - `routers/eventor.ts` lines 1–100, 500–660 and 1526–1866 (`pushResults` and `pushStartList`);
  - `routers/testLab.ts` after line 560;
  - `variants.ts` after line 200, and `course-variants.ts`.
- **Map store**: the `map-store/*-worker.ts` files, `heightfield.ts`, `previews.ts`, `colour-settings.ts`, `review-colours.ts`, `crt.ts`, the `dem-*` settings files and the `*-routes.ts` files past their auth checks were only grepped for DB calls. `course-maps/auto-sheets.ts` was not read.
- **PR254**: `leg-routes-auto-worker.ts`, `cli/calibrate-cost-model.ts`, the `eventor.ts` changes and the shared route and terrain code were not read. The lease and backup table-order changes were not checked against FK order.
- **Timings not measured**: real interactive-transaction timings (DB-06, DB-39), WAN latency to LiveResults (DB-09) and the event-delete scan cost (DB-51).
- **Not traced**: whether Eventor ever returns a 200 with no `EntryList` for a live event (DB-08 a); whether `navigator.onLine` is false on a venue laptop with no uplink but a reachable local API (DB-11); and how offline clients apply `course.upserted { removed: true }` (DB-17).

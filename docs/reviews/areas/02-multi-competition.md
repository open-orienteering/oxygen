# Area 02: multi-competition isolation

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Review only: no code was changed.

**Scope.** This area covers:
- multi-competition routing (`x-competition-id` / `x-event-id`, `trpc.ts` `createContext`);
- the single Prisma client and event scoping in every router;
- REST routes that resolve the event themselves;
- the venue/cloud sync paths that carry an event between nodes (forwarder, shipper, lease, settings refresh);
- background jobs that iterate events (LiveResults, ROC);
- module-level caches;
- the web client's per-event state: tRPC headers, outbox, react-query cache and persister, Dexie projection, card-reader state.

PR #254 (`claude/project-thread-avzbks`) was reviewed where it touches these paths.

**Base.** main at `df5460c3`. Line numbers are for that commit unless a finding says PR254.

**Method.**
1. Five Fable reviewers each read one slice of the area in full:
   - core and runner/readout routers;
   - course/control routers;
   - map/Eventor/tracks routers;
   - REST routes, sync and background jobs;
   - the web client.
2. The 5 reports were deduplicated into about 50 claims.
3. Ten fresh Fable verifiers received only the claims and locations, grouped by code location, never the reviewers' reasoning, and were asked to disprove them.
4. One claim was refuted and dropped (runner card check-then-insert race: a partial unique index `runners_event_id_card_no_key` prevents it; only a friendly-error residual is kept, MC-56).

Several severities were corrected by the verifiers; the values below are the verified ones. Nothing was executed against a database. "Confirmed" means proven from the code; two node one-liners were run (MC-50).

**Findings that belong to other areas.** Some findings were found here but belong elsewhere: Eventor, readout, results, backup, Test Lab, LiveResults. They are kept in this file, marked *(other area: …)* in the title, so nothing is lost. The coordinator should dedupe them against those areas.

## Summary

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 12 |
| Medium | 31 |
| Low | 11 |

**Fix these first:**
1. **MC-01.** `events.push` must reject entries whose `competitionId` is not the header event. The client must send the header of the entries, not of the URL. This is one root cause behind the worst cross-competition writes (also MC-17, MC-20).
2. **MC-02.** The journal shipper cursor skips entries that arrive late. On a venue box, station readouts silently never reach the cloud, and checkin reports 0 pending.
3. **MC-04, MC-05 and MC-06,** the offline card-reader trio:
   - MC-04: the react-query cache is not partitioned by event;
   - MC-05: the recent-card dedupe spans events;
   - MC-06: offline readouts never queue `result.applied`.

   Each can lose or misplace a readout at the finish.
4. **MC-03.** `events.push` has no capability check. On the cloud (proxy mode, `AUTH_AUTO_PROVISION=member`), any signed-in account can wipe any event's courses or runners.
5. **MC-08.** Settings refresh silently reverts venue edits every 5 minutes: card fee, payment methods, kiosk key, Sheets webhook.

**Root cause shared by many findings.** The web client derives the event header from `window.location` at *send* time (`packages/web/src/lib/trpc.ts:22-31`, `main.tsx:51-65`). It does not bind the event when a write is *created*. The server trusts the header alone. Wire ids for most entities are per-event `seq`, so a write sent under the wrong header usually succeeds against a row of the other event. Fixing MC-01 by adding a per-event client (`trpcClientForEvent(nameId)`) also unlocks fixes for MC-17, MC-20, MC-52 and MC-37.

---

## Critical

### MC-01 Outbox entries from event A are applied to event B when the operator switches competition mid-drain
- **Area:** multi-competition (server ingest plus web outbox). **Category:** functional / cross-competition corruption.
- **Severity:** critical. Two events are corrupted, and A's entries are lost because they are marked synced. Applies in every AUTH_MODE, including the arena laptop.
- **Location:**
  - `packages/api/src/routers/events.ts:88-151`: `ingestJournalEntries`. The idempotency lookup is at `:99-106`, the apply at `:108`, the journal row at `:122-134`.
  - `events.ts:69`: the schema carries `competitionId`, which is never read.
  - `events.ts:229-240`: `push`.
  - `packages/web/src/lib/offline/sync.ts:14-71` and `packages/web/src/hooks/useEventQueue.ts:48-76`.
- **What is wrong:**
  - The server applies every pushed entry to `ctx.event` from the header and never compares `entry.competitionId` with `event.nameId`.
  - `drainEventQueue(competitionId)` loops over 50-entry batches filtered by the competition captured when the drain started. Each `trpcVanillaClient.events.push` reads the header from the URL at send time.
  - The loop is not cancelled when the shell unmounts; `cancelled` only guards `setState`.
  - Idempotency is `journalEntry.findUnique({ id })` on a global primary key. A misapplied entry therefore reports `synced` for ever, even when it is later pushed under the right header.
  - The module-level `draining` flag also makes `drainEventQueue(B)` return 0 while A's drain runs, and the effect does not fire again.
- **Scenario:**
  1. On a two-race day the laptop has 120 pending `card.read` / `finish.recorded` / `runner.registered` entries for `race-am` after an outage.
  2. Wi-Fi returns and the drain starts.
  3. While batch 1 is in flight, the operator opens `race-pm` in the same tab.
  4. Batches 2 and 3 go out with `x-competition-id: race-pm`. `resolveRunner` matches by `(eventId, cardNo)` or by seq, so PM runners with the same cards get AM finish times. `runner.registered` creates AM runners in the PM class with the same seq.
  5. All entries are marked synced locally. `race-am` never gets them.
- **Fix (S server + M client):**
  - Server: in `ingestJournalEntries`, before the idempotency lookup, push `{ id, error: "EVENT_MISMATCH" }` into `failed` and `continue` when `entry.competitionId !== event.nameId`. The node shipper already stamps `event.nameId` (`shipper.ts:83-106`, `events.ts:209`), so peers are unaffected. Also make the lookup `{ id, eventId }`-aware, and fail loudly when the id exists under another event.
  - Client: add `trpcClientForEvent(nameId)`, a vanilla client cached per nameId whose `headers` and `scopeTrpcUrl` use the given nameId, never `window.location`. `drainEventQueue` groups pending entries by `competitionId` and pushes each group through its own client.
  - Tests:
    - an integration test in `events-push.test.ts` that pushes an entry whose `competitionId` differs from the header and expects `failed` with no rows written;
    - a web unit test with two competitions pending and the location set to the other one.
- **Status:** confirmed from code by two independent verifiers, one on the server side and one on the client side.

### MC-02 The journal shipper's HLC watermark skips entries that are ingested late; checkin then reports 0 pending
- **Area:** multi-competition / venue-cloud sync *(overlaps area: offline-first sync)*. **Category:** stability / data loss.
- **Severity:** critical for venue + cloud deployments. Does not apply to a single node.
- **Location:**
  - `packages/api/src/sync/shipper.ts:194-220` (push) and `:231-254` (pull, same flaw).
  - `packages/api/src/routers/events.ts:185-196`: the `listJournalEntriesSince` predicate `hlc > cursor`.
  - `events.ts:110-131`: an ingested entry is stored under the station's creation-time HLC (stamped at `packages/web/src/lib/offline/events.ts:59`).
  - `packages/api/src/sync/lease.ts:383-401`: `shippingStatus`.
  - `packages/api/src/routers/lease.ts:234-246`: the checkin barrier.
- **What is wrong:**
  - Push and pull select `hlc > watermark` and advance the watermark to the HLC of the last acknowledged entry.
  - A station entry keeps its own, older HLC when the box ingests it. `foldServerHlc` only moves the node clock forward and does not restamp.
  - Any entry that reaches the box after a newer entry has already shipped is never selected again. The shipper runs every 5 s (`nodeIdentity.ts:50-53`), so no long outage is needed.
  - `shippingStatus` uses the same predicate and reports 0 pending.
  - `docs/system/offline-architecture.md:317-319` claims "a watermark never skips past an unapplied entry". That is false.
- **Scenario:**
  1. A start station's Wi-Fi drops for 30 s and it records 3 entries stamped 09:05:10.
  2. Meanwhile the box ships its own 09:05:20 entry, so the watermark is 09:05:20.
  3. The station drains at 09:05:40. Its entries land with HLC 09:05:10 and are never pushed.
  4. Checkin passes.
  5. The cloud lacks them. The next checkout runs `tx.event.deleteMany` on the venue copy (`sync/lease.ts:319`), and the entries are gone for good.
- **Fix (M):**
  - Ship by local arrival order, not by HLC. Add a per-node monotonic `ingest_seq BIGSERIAL` column on `journal` with an index on `(event_id, ingest_seq)`.
  - Make the shipper cursor, `shippingStatus` and the snapshot `journalCursor` all use it. Keep `(hlc, id)` only as the apply order.
  - Correct the doc.
  - Add a two-node integration test that ingests an entry with an HLC below the watermark and asserts it ships.
- **Status:** confirmed from code.

### MC-03 `events.push` has no capability check: any signed-in account can rewrite or wipe any event
- **Area:** multi-competition / auth. **Category:** security (authorisation).
- **Severity:** critical on a cloud deployment (proxy mode). Not applicable with AUTH_MODE=off.
- **Location:**
  - `packages/api/src/routers/events.ts:229`: `push` is a plain `eventProcedure`.
  - `packages/api/src/trpc.ts:163`: `authedProcedure.use(requireEvent)`.
  - `scripts/gcp/deploy.sh:175`: `AUTH_AUTO_PROVISION=member`.
  - `packages/api/src/auth.ts:67-70,131`: any proxy-authenticated email is created as a member.
  - Documented as deliberate at `docs/system/authentication.md:231-232`.
- **What is wrong:**
  - A member with no grant on event X can push any of the 16 entry types with the header `x-competition-id: X`.
  - That includes `reference.imported { replaceAll: true }`, which soft-removes every course and control and unlinks every class (`events.ts:705-723`). It also includes `runner.deleted`, `result.applied` and `runner.updated` with arbitrary fields.
  - The push also bypasses the lease guard.
  - The equivalent tRPC mutations all require `event.manage`, `race.operate` or `courses.edit`.
- **Scenario:** a club member whose Google account IAP admits posts a single `reference.imported` entry with empty lists for the club championship. All courses and controls are removed on race morning.
- **Fix (M):**
  - Split the gate. A valid `x-oxygen-sync-secret` (compared constant-time) passes as the peer path; the shipper posts here with only the secret, `shipper.ts:92-105`.
  - Otherwise compute `capabilitiesForContext` once and require a capability per entry type:
    - `race.operate` for card, finish, start, punch and result entries;
    - `event.manage` for `runner.*` and `class.upserted`;
    - `courses.edit` for `course.upserted`, `control.upserted` and `reference.imported`.
  - Entries without the capability go to `failed`.
  - Update `authentication.md:231`. Add `permissions.test.ts` cases.
  - This also answers the open question of whether venue→cloud push works behind IAP today (see "Not verified").
- **Status:** confirmed from code. The gap is documented, but no rationale is given.

---

## High

### MC-04 The react-query cache, in memory and persisted, is not partitioned by event; offline you see and read out against another event's data
- **Area:** multi-competition (web). **Category:** functional / competition mix-up.
- **Severity:** high.
- **Location:**
  - `packages/web/src/lib/offline/persister.ts:4`: one IndexedDB key, `oxygen-query-cache`.
  - `packages/web/src/main.tsx:76-87`: no `buster`, maxAge 24 h.
  - `packages/web/src/pages/CompetitionShell.tsx:140-153`: the offline `onError` takes the name from whatever `competition.dashboard` is cached.
  - `CompetitionShell.tsx:229-255`: the offline branch skips reset and invalidate. The comment at `:235-238` admits the keys carry no event.
  - Consumers: `packages/web/src/lib/offline/local-readout.ts:62-63, 167-168`.
- **What is wrong:**
  - Event-scoped queries have input `undefined`, so their keys carry no event.
  - The only guard is `utils.invalidate()` plus `reset()` on shell mount, and both are skipped offline.
  - Online, `invalidate` only marks queries stale. Inactive queries keep A's data under B until a refetch, and keep it if the refetch fails on a flaky network where `navigator.onLine` is still true.
  - The persister writes the whole cache under one key, so two tabs on different events overwrite each other.
  - Nothing calls `queryClient.clear()` or `removeQueries`.
- **Scenario:**
  1. On day 1 the laptop runs `ds-day1`. Day 2 is a separate event, `ds-day2`.
  2. In the morning, with no network yet, the operator opens `/ds-day2`.
  3. The persisted cache (under 24 h old) makes the shell "ready" with day 1's name, runners, classes and courses.
  4. Offline readouts are judged against day 1's courses and queued with `competitionId: ds-day2` and day 1's runner seqs.
- **Fix (M):**
  - Persist per event (`createIdbPersister(nameId)` with key `oxygen-query-cache:<nameId>`), plus one small cache for non-event pages.
  - When the event changes, call `queryClient.clear()` and restore that event's blob, instead of invalidate/reset.
  - Add `nameId` to the dashboard payload and accept a cached dashboard offline only when it matches.
  - Add an e2e test: visit A, go offline, open B, and expect "not available offline" rather than A's data.
- **Status:** confirmed from code.

### MC-05 The card reader's duplicate detection spans competitions; a card re-read in the correct event is never stored
- **Area:** multi-competition (web). **Category:** functional / lost readout.
- **Severity:** high.
- **Location:** `packages/web/src/context/DeviceManager.tsx`:
  - `:268-290`: `setCompetitionNameId` does not touch `recentCardsRef`.
  - `:313-321`: dedupe by `readoutsMatch`, with no time window and no event.
  - `:357`: `!isDuplicate` gates `storeReadout`.
  - `:417`: the offline `card.read` is gated too.
  - `:407-416`: a read with no competition is only logged with `console.warn`.
  - The provider is app-level (`App.tsx:61`).
- **What is wrong:**
  - The recent-cards list lives for the whole page session.
  - A second read of a card with identical punches is treated as a duplicate and not stored, although the first read was stored in a different event or nowhere.
  - On the selector or settings page, a read stores nothing and queues nothing. The flow then falls through to local readout (`:531`) and can show a result computed from whatever event is cached (MC-04).
  - `docs/system/registration-and-readout.md:131` says duplicates are detected "within a short window", but the code has no window.
- **Scenario:**
  1. The operator still has yesterday's event open, or is on the selector, and reads the first finisher's card.
  2. They notice, switch to today's event without reloading, and read the card again.
  3. The read is treated as a duplicate and no `storeReadout` reaches today's event, so the runner has no card data and no result. Re-reading does not help until the page is reloaded or the manual "clear" button is pressed.
- **Fix (S):**
  - Clear `recentCards`, `recentCardsRef` and `currentCard` when the nameId changes.
  - Record on each `RecentCard` the nameId it was stored under and whether the store or queue succeeded. Count a read as a duplicate only when both match.
  - Show a visible "no competition open, card not saved" notice.
  - Correct the doc sentence.
- **Status:** confirmed from code.

### MC-06 Offline readouts never queue `result.applied` (stale closure); after sync the runner has a card but no result
- **Area:** found here *(other area: SI readout / offline sync)*. **Category:** functional / data loss offline.
- **Severity:** high.
- **Location:** `packages/web/src/context/DeviceManager.tsx:572`, which tests state `competitionNameId` (declared `:252`, initially null). Deps `[]` at `:603-605`. The emit at `:573-579` is dead. Server side: `packages/api/src/routers/events.ts:731-789`, where `card.read` stores the card but never sets status or finish; only `result.applied` does (`:391-416`).
- **What is wrong:**
  - `addRecentCard` is a `useCallback` with empty deps, so it closes over the first render's `competitionNameId`, which is null.
  - The offline branch therefore never emits `result.applied`.
  - Every other emit in the callback uses `competitionNameIdRef.current` (`:409, :419, :515`).
- **Scenario:**
  1. The network is down and 80 runners read out at the finish.
  2. The kiosk shows OK and a time for each, and `card.read` is queued.
  3. After sync the server has 80 cards and 80 runners with status Unknown, so the result list omits them (`lists.ts:171` ranks on status) until each card is re-read online.
- **Fix (S):**
  - Use `competitionNameIdRef.current` at `:572`.
  - Add a unit test that drives `addRecentCard` offline and expects two outbox entries.
  - Fix MC-04 first, or send only `cardNo` and let the server resolve the runner. Otherwise the now-live `runnerId` can come from another event's cached runner list.
  - Also note that `events.ts:398-411` maps only statuses 1/3/4 and turns the rest into "unknown".
- **Status:** confirmed from code.

### MC-07 `applyReferenceUpsert` writes by row UUID with no event check and passes wire `fields` straight into Prisma `update`
- **Area:** multi-competition. **Category:** security / stability (cross-event write, mass assignment).
- **Severity:** high. It becomes critical together with MC-03.
- **Location:** `packages/api/src/routers/events.ts:843-915`:
  - upserts at `:866`, `:875`, `:898`;
  - `fields` copied at `:852-857`;
  - children replaced at `:881-893` and `:904-914`.
- **What is wrong:**
  - The code runs `upsert({ where: { id: payload.id }, create: {…, eventId}, update: fields })`. If the UUID belongs to another event's class, course or control, the update branch modifies that row.
  - `fields` is an unvalidated `z.record`. `eventId`, `removed` and `seq` from the wire are applied; unknown keys throw. The emitter strips them (`referenceJournal.ts:36`), but the receiver does not.
  - `courseControl.deleteMany({ courseId })` and `classCoursePool.deleteMany({ classId })` run by bare id. They then `createMany` child rows whose `controlId`/`courseId` are never checked against the event.
  - The delete and recreate are not in a transaction, so a foreign-key failure in `createMany` leaves the course with zero controls.
- **Scenario:** with header `b`, a client pushes `course.upserted { id: <uuid of a course in a>, fields: { removed: true }, courseControls: [] }`. Event a's course is soft-removed and its control sequence deleted, and the entry is journaled under b.
- **Fix (S-M):**
  - Before each upsert, `findUnique({ where: { id }, select: { eventId: true } })` and throw when the row exists in another event.
  - Allow-list `fields` per entity, never `id`, `eventId`, `seq`, `createdAt` or `updatedAt`.
  - Verify that child `controlId`/`courseId` belong to `eventId`.
  - Run the delete and recreate in one transaction.
  - Add an integration test that pushes another event's UUID and expects `failed` with the row unchanged.
- **Status:** confirmed from code.

### MC-08 Settings refresh overwrites event settings edited on the venue box every 5 minutes
- **Area:** multi-competition / venue-cloud. **Category:** functional / data loss; the docs disagree with the code.
- **Severity:** high on venue deployments.
- **Location:**
  - `packages/api/src/sync/settingsRefresh.ts:26-34, 49-56`: copies every column except id, nameId, zeroTime, date, removed and the timestamps.
  - Cadence at `sync/shipper.ts:363-366`: 5 minutes while the box holds the lease.
  - Local writers that are not forwarded (none are in `packages/shared/src/cloud-ownership.ts:16-44`):
    - `routers/event.ts:284-287` (`updateType`);
    - `routers/event.ts:891-927` (`setRegistrationConfig`: payment methods, Swish, receipts);
    - `routers/event.ts:942-945` (`setGoogleSheetsConfig`);
    - `routers/event.ts:969-972` (`setCardFee`);
    - `routers/event.ts:987-989` (`regenerateKioskKey`);
    - `routers/control.ts:1408-1422` (`setAirPlusConfig`);
    - `routers/course.ts:1654-1657` (`setOverprintCuts`).
- **What is wrong:**
  - `docs/system/offline-architecture.md:100-108` and the header of `settingsRefresh.ts` (lines 4-6) say these writes are forwarded to the cloud. They are not: they run locally on the box and are then reverted.
  - Even without the revert, they never reach the cloud and are lost at checkin.
- **Scenario:** at the arena, the operator raises the rental-card fee on the box and regenerates the kiosk key. Within 5 minutes both revert. Kiosks holding the new key get 401, and receipts show the old fee.
- **Fix (M):**
  - Either add these paths to `CLOUD_OWNED_MUTATIONS`, so they forward and fail loudly offline as the doc says, or switch the refresh to an explicit allow-list of cloud-owned columns.
  - Decide per field. `airPlus`, `awakeHours` and the card fee may need to be editable on the venue offline, which means excluding them from the refresh and shipping them back. That decision is Marcus's.
  - Add a test that every `event.update` writer is either forwarded or excluded from the refresh.
- **Status:** confirmed from code.

### MC-09 `lease.checkout` deletes the local event without checking for unshipped entries, and requires no capability
- **Area:** multi-competition / venue-cloud. **Category:** stability / data loss; security.
- **Severity:** high for the deletion, medium for the authorisation.
- **Location:**
  - `packages/api/src/routers/lease.ts:141-169`. The only authorisation is `ctx.authEnabled && !ctx.user` at `:144`; `peer.acquire` is at `:154`.
  - `packages/api/src/sync/lease.ts:317-320`: `tx.event.deleteMany({ where: { nameId } })` cascades to the journal and sync state.
- **What is wrong:**
  - `peer.acquire` fails if a cloud lease is active, so this cannot happen while the box holds the lease.
  - It is reachable in three ways:
    1. after `forceTakeover` on the cloud, when the revived box clicks Checkout instead of letting entries drain (`offline-architecture.md:261-264` describes this path as recoverable);
    2. after checkin, for local writes made while the link was down;
    3. for anything MC-02 skipped.
  - Any signed-in venue user (anyone with AUTH_MODE=off) can check out any cloud event by slug, which blocks race-critical writes on the cloud.
- **Scenario:**
  1. The box dies and the cloud takes over.
  2. The box comes back with 40 unshipped readouts.
  3. The operator clicks Checkout and the 40 entries are deleted.
- **Fix (S-M):**
  - Before `peer.acquire`, if a local event with that nameId exists, run `shipEventOnce` and an arrival-order pending check (see MC-02). Refuse while anything is pending unless `discardLocal: true`.
  - Require `event.manage` on the existing local event, or instance admin when there is none.
- **Status:** confirmed from code.

### MC-10 The ROC control mapping set in the UI is never applied: the router and the puller use different settings keys
- **Area:** multi-competition (per-event state keyed wrongly) *(overlaps area: readout/radio)*. **Category:** functional.
- **Severity:** high.
- **Location:**
  - Write side: `packages/api/src/routers/onlineInput.ts:202-223` stores `cfg.mapping` in `online_input_<eventId>_config`.
  - Read side: `packages/api/src/online-input/puller.ts:235`, then `online-input/mapping.ts:31-39` with the key `online_input_mapping_<nameId>`. `cfg.mapping` is parsed (`puller.ts:72`) but never used.
  - `applyMapping` is at `puller.ts:252`.
- **What is wrong:**
  - Nothing in the app writes the nameId key. Only `__tests__/integration/online-input.test.ts:210` calls `saveMapping` directly, which is why the test passes.
  - The mapping table on the EventPage (`EventPage.tsx:883-936`) edits a mapping the puller never reads.
  - `docs/system/online-input-roc.md:65-69, 116, 147` describes the dead key.
- **Scenario:** the operator maps ROC code 100 to Finish. Radio punches arrive stored as control 100, so radio finish times are never recognised.
- **Fix (S):**
  - Make `pollOnce` use `cfg.mapping`, which is already loaded and keyed by event id.
  - Delete `loadMapping`/`saveMapping`.
  - Rewrite the test to go through `onlineInput.addMapping`, and correct the doc.
  - This also removes the latent risk that a slug-keyed mapping is inherited by a future event that reuses the slug.
- **Status:** confirmed from code.

### MC-11 The per-event backup silently omits the journal, and a failed section still yields a "successful" dump
- **Area:** found here *(other area: backup/ops)*. **Category:** functional / data loss; docs.
- **Severity:** high.
- **Location:**
  - `packages/api/src/backup.ts:151`: `"event_log"` in `BACKUP_TABLES`.
  - `backup.ts:196`: `SELECT * FROM oxygen.event_log`.
  - `backup.ts:238-250`: psql runs with `-q -X -f -` and no `ON_ERROR_STOP`.
  - `backup.ts:300-308`: a failure trailer is written only on a non-zero exit, and stderr is dropped.
  - `docs/ops/backup-restore.md:7` contradicts `:18`.
- **What is wrong:**
  - Migration `20260601130000_journal_rename` renamed `event_log` to `journal` (`schema.prisma:1085`).
  - The `\copy` fails, psql continues and exits 0, so no `-- BACKUP FAILED` trailer is written.
  - `__tests__/integration/backup.test.ts:147` only asserts that the trailer is absent, so it cannot catch this.
  - Event-scoped tables missing from the dump that the doc never mentions: `card_readout_backups`, `map_colour_settings`, `event_permissions`, `eventor_entry_history`.
  - Also missing: the per-event `settings` rows (`liveresults.ts:684`, `online-input/puller.ts:87-136`, `routers/onlineInput.ts:69`).
- **Scenario:** an operator downloads a backup before the event. It has an empty journal section and no warning, and any future table rename fails the same way.
- **Fix:**
  - S:
    - add `-v ON_ERROR_STOP=1`;
    - rename the entry to `journal`, or drop it and correct the doc;
    - wrap the script in one `REPEATABLE READ` transaction;
    - add a unit test that every `BACKUP_TABLES` name is a `@@map` in the Prisma schema;
    - assert in the integration test that every section has a header row.
  - M: decide on the missing tables and settings rows, and add restore support for them.
- **Status:** confirmed from code. The psql behaviour is reasoned from psql's documented semantics; no Postgres was available to run it.

### MC-12 `eventor.sync` cancels finished runners, cancels results-only runners on every sync, and overwrites local corrections
- **Area:** found here *(other area: Eventor import/export)*. **Category:** functional / data corruption.
- **Severity:** high. Critical if sync is run mid-event: statuses are mass-rewritten with no journal entry and no undo.
- **Location:**
  - `packages/api/src/routers/eventor.ts:1183-1199` (withdrawn detection). The `existing` query at `:958-962` does not filter `removed`.
  - `packages/api/src/eventor.ts:699-700` (`fetchEntries` returns `[]`).
  - `routers/eventor.ts:1144-1181` (results-only loop); `seen.add` is called only at `:1140`.
  - `routers/eventor.ts:1033-1038, 1075-1086` (result overwrite).
- **What is wrong:**
  1. Every runner with an `eventorPersonId` that is absent from `entries` is set to Cancel, whatever their status (OK, MP or DNF). `fetchEntries` returns `[]` on any 200 response without `EntryList.Entry`, such as a maintenance page, so one bad response cancels everyone.
  2. Results-only runners are never added to `seen`, so they are cancelled on the second sync and never reinstated.
  3. When Eventor has a result, local `startTime`, `finishTime` and `status` are overwritten unconditionally.
- **Scenario:** at 12:00 the operator pushes preliminary results. At 12:10 they correct an MP to OK. At 12:20 they run Sync to pick up late entries, and the correction reverts to the 12:00 state.
- **Fix (M):**
  - Abort the withdrawn step when `entries.length === 0`, or when the cancel count exceeds a threshold.
  - Never cancel a runner with a finish, a card read, or a status other than Unknown.
  - Make `fetchEntries` throw when the root element is not `EntryList`.
  - Call `seen.add(result.personId)` in the results-only loop.
  - Apply Eventor result fields only when the local runner has no result.
  - Extend `__tests__/integration/eventor-reentry.test.ts` with these three cases.
- **Status:** confirmed from code, all three parts.

### MC-13 `eventor.importEvent` is not atomic and does not pre-check the slug; a failed import leaves the operator stuck
- **Area:** found here *(other area: Eventor)*; touches event identity. **Category:** stability / partial write.
- **Severity:** high.
- **Location:**
  - `packages/api/src/routers/eventor.ts:694-729`: the transaction covers only the event and meta rows.
  - `routers/eventor.ts:731-846`: classes, clubs and runners are created one by one on the bare client.
  - `schema.prisma:99`: `nameId @unique`.
  - Soft delete at `routers/event.ts:327-329`.
- **What is wrong:**
  - A failure partway through (a card_no unique hit, or a dropped connection) leaves an event with only some of its runners.
  - The retry hits P2002 on `nameId`.
  - Soft-deleting the half-imported event does not free the slug (see MC-27), so the operator cannot recover without database access.
  - There is no slug pre-check, so a yearly event with the same name also fails with a raw P2002.
- **Scenario:** importing "Vårserien 1" over arena Wi-Fi drops at runner 800 of 1,500. The event looks complete but is not, and re-importing fails with "Unique constraint failed".
- **Fix (M):**
  - Check the slug before any Eventor fetch: return CONFLICT, or suffix the slug with the year or the Eventor id.
  - Do the import in one transaction with a raised timeout using `createMany` in chunks, or make it resumable through `sync`.
- **Status:** confirmed from code.

### MC-14 `lists.resultList` gives tied runners consecutive places
- **Area:** found here *(other area: results)*. **Category:** functional / wrong results.
- **Severity:** high: a wrong published placing whenever two runners tie to the tenth of a second.
- **Location:**
  - `packages/api/src/routers/lists.ts:181-202` (`entry.place++` at `:199`).
  - Consumer: `packages/web/src/pages/ResultsPage.tsx:33, 143-145`.
- **What is wrong:**
  - Equal running times get places 3 and 4, and which runner comes first depends on query order.
  - The correct helper, `computeClassPlacements` (`results.ts:7`, with tie tests in `__tests__/results.test.ts:57-67`), is used for the Eventor upload (`routers/eventor.ts:1655`).
  - `race.finishReceipt` shares ranks too (`race.ts:234-254`).
  - The results page can therefore disagree with the receipt and with Eventor.
- **Scenario:** two H21 runners finish in 45:12.3. The results page shows them 3rd and 4th, while the receipt and Eventor show both as 3rd.
- **Fix (S):** use `computeClassPlacements`. First check that it can rank on the adjusted time: `resultList` subtracts `adj` at `:176-177`.
- **Status:** confirmed from code.

### MC-15 Test Lab can destroy a live event's runners and results with no lease check and no journal
- **Area:** found here *(other area: API routers)*. **Category:** stability / data loss.
- **Severity:** high. Arguably critical with AUTH_MODE=off at the arena.
- **Location:**
  - `packages/api/src/routers/index.ts:55`: the router is mounted unconditionally, with no environment gate.
  - `packages/web/src/pages/CompetitionShell.tsx:642` and `packages/web/src/lib/shell-tabs.ts:58`: the page is in the More menu of every event.
  - `packages/api/src/routers/testLab.ts`:
    - `:243-248`: `clearRunners` runs `runner.deleteMany`, a hard delete;
    - `:292-551`: `startSimulation`, with runner selection at `:327-334` and overwrites in `processSimulatedReadout` at `:141-178`;
    - `:182` and `:273`: `generateEvent` and `defaults` are `publicProcedure`.
- **What is wrong:**
  - These are `manageProcedure` writes made directly through Prisma, with no `assertRaceWritable` and no journal.
  - `clearRunners` is guarded only by a browser `confirm()` (`TestLabPage.tsx:109`).
  - `startSimulation` has no confirm at all (`TestLabPage.tsx:230`). It overwrites `card.punchesRaw`, `cardId`, `finishTime` and `status` for every started runner with a card.
  - `docs/guide/platform.md:79` presents Test Lab as a product feature.
- **Scenario:** during a live event someone opens Test Lab and presses Start simulation. Every started runner gets a synthetic card and a random OK/MP/DNF result over the real readout, and there is no journal trail to undo it.
- **Fix (S-M):**
  - Gate the router and the tab behind `ENABLE_TEST_LAB=1` or an explicit per-event "test event" flag; otherwise return FORBIDDEN.
  - Refuse when any non-simulated card exists.
  - Make `generateEvent` admin-only or delete it. It also writes a float into the `Course.lengthM Int` column (`:204`); that is plausible, not run.
- **Status:** confirmed from code.

---

## Medium

### MC-16 Mutations paused offline by react-query replay later under whatever event is open, or are dropped after a reload
- **Area:** multi-competition (web). **Category:** functional.
- **Severity:** medium. Readout and registration branch to the outbox on `navigator.onLine` (`RegistrationDialog.tsx:615-648`); the exposure is the roughly 120 other `useMutation` call sites (admin edits).
- **Location:** `packages/web/src/main.tsx:19-27` (no `networkMode`), `:51-65`, `:82-86` (`shouldDehydrateMutation: () => true`). There is no `setMutationDefaults` anywhere.
- **What is wrong:**
  - With TanStack Query v5 (5.107.1) defaults, a mutation started offline is paused and resumes when the browser is back online, even after its component unmounted. The header is computed at resume time.
  - Dehydrated mutations rehydrate without a `mutationFn` and are dropped silently.
- **Scenario:** offline, the operator changes runner 57's class in event A, then opens event B. When Wi-Fi returns, `runner.update({ id: 57 })` is sent to B and modifies B's runner with seq 57.
- **Fix (S):** set `mutations: { networkMode: "always" }` so offline mutations fail visibly, and set `shouldDehydrateMutation: () => false`. Structurally, use the per-event header from MC-01.
- **Status:** plausible. Strong from code plus the library semantics of the pinned version; not reproduced.

### MC-17 The field-mode control outbox drains under the URL's event; a queued check-off lands on another event's control
- **Area:** multi-competition (web). **Category:** functional.
- **Severity:** medium (course-setting data, not results).
- **Location:**
  - `packages/web/src/lib/offline/control-outbox.ts:312-384` (send at `:338-340`).
  - `packages/web/src/pages/editor/useFieldOutbox.ts:93-103, 107, 126-133`: cleanup clears only the timer.
  - `packages/web/src/pages/editor/EditorPage.tsx:156`.
  - Server: `packages/api/src/routers/control.ts:1075-1089`; `control.check` takes no version token.
- **What is wrong:** the drain sends one request per entry with the URL-derived header and is not stopped when the user navigates. A move with `baseVersion` usually becomes a conflict (`control.ts:998-1001`). A check-off, or a move queued without a token, is written to the other event's control with the same code.
- **Scenario:** a course setter's tablet syncs 15 queued check-offs. The setter switches to the sister event, and the remaining check-offs mark the sister event's controls as checked.
- **Fix (S, given MC-01):** check before each send that the route's event equals `competitionId`, and send through `trpcClientForEvent`.
- **Status:** mechanism confirmed from code.

### MC-18 Pending outbox entries of other events are invisible and are never drained
- **Area:** multi-competition (web). **Category:** stability / silently unsynced data.
- **Severity:** medium. The entries are not lost (`cleanupSyncedEvents` only deletes synced rows).
- **Location:**
  - `packages/web/src/hooks/useEventQueue.ts:31-45, 48-76`. The total is only written to `console.log` at `:34-37`.
  - `packages/web/src/components/SyncStatusIndicator.tsx:157-161`.
  - `packages/web/src/pages/CompetitionShell.tsx:460`, the only mount.
- **Scenario:**
  1. The morning race ends offline with 30 queued finishes.
  2. The operator opens the afternoon race. The indicator is green.
  3. The 30 entries stay in IndexedDB until someone reopens the morning race online on that laptop, and a `failed` entry for it is equally invisible.
- **Fix (S, then M):** show "N unsynced in other competitions" in the indicator and on the selector. Once MC-01's per-event client exists, drain every event's entries from any page, grouped by `competitionId`. Do not call `drainEventQueue()` with no argument before then.
- **Status:** confirmed from code.

### MC-19 `findCachedQuery` picks the first cached `runner.list` regardless of input, so offline readout can miss every runner
- **Area:** multi-competition (web). **Category:** functional.
- **Severity:** medium.
- **Location:**
  - `packages/web/src/lib/offline/local-readout.ts:320-331`, with callers at `:62-63, :167-168, :299`.
  - The input variants in use:
    - `undefined`: `useStationSync.ts:30/59`, `useProjectionSync.ts:18`;
    - `{}`: `RunnerManagement.tsx:44`;
    - `{ search }`: `CardsPage.tsx:397-400`.
- **What is wrong:**
  - It returns the first query whose path matches. The most likely failure is that the data-less, disabled entry with `undefined` input created at shell mount is found first. `findCachedQuery` then returns undefined and offline readout says "register" although `runner.list({})` is cached.
  - After a restore, a search-filtered list can also come first.
- **Fix (S):** look up exact keys (`runner.list` with undefined input, then `{}`), skip entries without data, and never accept an input that has `search`. Do it together with MC-04.
- **Status:** mechanism confirmed; the trigger is narrow.

### MC-20 Server dedupe for `runner.registered` and `punch.recorded` looks up ids across all events and silently drops the entry
- **Area:** multi-competition. **Category:** functional.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/events.ts:475-480`: `runner.findUnique({ id: tempId })` at `:476`.
  - `events.ts:594-599`: `punch.findUnique({ id })` at `:595`.
  - Contrast `resolvePunch` (`:806-809`), which is scoped by event.
- **What is wrong:**
  - A UUID that exists in another event skips the create, and the entry is still journaled as synced.
  - Without the lookup, the create would fail loudly on the primary key, so the dedupe turns a visible failure into a silent loss.
  - This happens after an MC-01 misapply, or with a client bug.
- **Fix (S):** use `findFirst({ where: { id, eventId } })`, and throw when the id exists under another event.
- **Status:** confirmed from code.

### MC-21 Journal ingest applies an entry and writes its journal row in separate statements
- **Area:** multi-competition / sync. **Category:** stability / partial write.
- **Severity:** medium.
- **Location:** `packages/api/src/routers/events.ts:108` (apply), `:122-134` (journal insert), `:137` (follow-up). There is no `$transaction`.
- **What is wrong:** most appliers are idempotent, but three effects are real:
  1. `runner.registered`: a crash after the create means the retry finds the runner and deals no variant, so the runner has no variant.
  2. Last-write-wins types (`finish.adjusted`, `start.adjusted`, `runner.updated`, `result.applied`): a retry after an operator correction re-applies stale values.
  3. Multi-statement applies (`reference.imported`, course children) can be left partial.
- **Fix (M):**
  - Wrap the apply, the journal insert and the follow-up in one `db.$transaction` per entry, passing `tx` down. `storeReadoutImpl` and `dealVariantFollowUp` must accept a transaction client.
  - Keep the Sheets push (`:786`) after commit.
- **Status:** confirmed from code.

### MC-22 The checkout snapshot is not one consistent read; an entry ingested during the export reaches neither the snapshot nor the pull
- **Area:** multi-competition / venue-cloud. **Category:** stability (race).
- **Severity:** medium.
- **Location:**
  - `packages/api/src/sync/lease.ts:247-294`: tables are read one at a time (`:256-270`) and the journal head afterwards (`:277-281`).
  - Contrast `sync/mapRefresh.ts:226-231`, which uses REPEATABLE READ.
  - The pull starts at the head: `routers/lease.ts:179-184`.
- **What is wrong:** `events.push` is deliberately not lease-guarded. A ROC punch or a station drain applied after its table was read, but journaled before the head read, is lost on the venue for the whole lease.
- **Fix (S on top of MC-02):**
  - A REPEATABLE READ transaction alone is not enough, because an entry with an HLC below the head that is ingested later is missed by the MC-02 mechanism.
  - Read the arrival-order head before the tables, and let the first pull overlap (ingest is idempotent).
- **Status:** confirmed from code.

### MC-23 The shipper ships every local event and matches it to the cloud by slug only
- **Area:** multi-competition / venue-cloud. **Category:** functional / competition mix-up.
- **Severity:** medium. Unusual precondition, but the effect is two merged competitions.
- **Location:**
  - `packages/api/src/sync/shipper.ts:268-294`: `findMany({ where: { removed: false } })`.
  - Slug-only addressing at `:93, :204`.
  - Start regardless of role at `:344-347`.
- **What is wrong:**
  - There is no event UUID or origin marker on the wire.
  - A box-local event can exist: created before peering was set up, made by Test Lab or a restore, or on a node with `SYNC_PEER_URL` set but a role other than venue.
  - Such an event with the same slug as a different cloud event (slugs come from names, `sanitizeNameId`) merges journals in both directions.
- **Fix (S-M):** ship only events that have a `journalSyncState` or lease row for this peer, which checkout creates. Alternatively, carry a stable event UUID and have the peer verify it.
- **Status:** mechanism confirmed from code; the collision scenario is plausible.

### MC-24 The venue forwarder has no timeout and no node credentials, and relays a client-supplied identity header
- **Area:** multi-competition / venue-cloud. **Category:** stability, security.
- **Severity:** medium.
- **Location:** `packages/api/src/sync/venueForwarder.ts:164-182`; the identity copy is at `:174-179` and is documented at `docs/system/authentication.md:129-131`.
- **What is wrong:**
  - The forwarder uses plain `fetch` with no signal. Undici's defaults mean a hang of about 5 minutes on a black-holed uplink, instead of answering `CLOUD_UNREACHABLE`.
  - It sends no `makeSyncHeaders` and no sync secret (compare `lease.ts:25`, `shipper.ts:52`). Behind IAP (`docs/ops/deploy-gcp-cloud-run.md:223-262`) every forwarded call is therefore rejected.
  - A venue with AUTH_MODE=off has no identity to forward, so a cloud in proxy mode answers UNAUTHORIZED.
  - If the cloud API is reachable without a header-stripping proxy, a LAN client can spoof `x-forwarded-email`.
- **Fix (M):**
  - Add `AbortSignal.timeout(15_000)` and send `makeSyncHeaders` plus the secret.
  - On the cloud, accept a forwarded identity only with a valid secret.
- **Status:** confirmed from code. The security part depends on the deployment.

### MC-25 The kiosk key authorises `race.recordFinish`, contradicting the auth doc, and the journal entry has no actor
- **Area:** multi-competition / auth. **Category:** security; docs.
- **Severity:** medium; high if proxy-mode kiosks are on public screens.
- **Location:**
  - `packages/api/src/routers/race.ts:320`, with the handler at `:346-361`.
  - `packages/api/src/trpc.ts:262-289` and `:341-347`.
  - `docs/system/authentication.md:213` says "Mutations never accept the key".
  - Used by `packages/web/src/pages/KioskPage.tsx:731-744`.
- **What is wrong:**
  - Whoever has the kiosk URL (`?k=`) can set `finishTime` and any `status` for any runner of that event.
  - The chain never calls `runWithActor`, so `appendJournal` records actor null even for a signed-in user (`journalEmit.ts:65`).
- **Fix (S):**
  - Split a narrow kiosk mutation (own card only, no `status` input, only when `finishTime` is 0) from the operator `recordFinish` on `raceOperateRaceProcedure`.
  - Wrap `kioskOrCapProcedure` in `runWithActor(ctx.user?.id ?? null, …)`.
  - Correct the doc.
- **Status:** confirmed from code.

### MC-26 Unauthenticated `publicProcedure`s expose the runner directory, spend the Eventor key and create events
- **Area:** multi-competition / auth. **Category:** security.
- **Severity:** medium; proxy mode only.
- **Location:**
  - `packages/api/src/routers/eventor.ts`: `events` `:582`, `searchEvents` `:604`, `eventDetail` `:630`, `syncRunnerDb` `:1220` (mutation), `runnerDbStatus` `:1363`, `searchRunnerDb` `:1376`, `lookupByCardNo` `:1421`, `clubMembers` `:1447`, `runnerDbDump` `:1474`, `fetchEntryHistory` `:1898` (mutation).
  - `routers/testLab.ts:182, 273`.
  - `routers/registrationTrends.ts:131, 174, 242, 305, 321`.
  - `routers/clubRouter.ts:222`.
  - `routers/event.ts:767`.
- **What is wrong:**
  - These contradict `authentication.md:39-41` ("every request except users.me … is gated").
  - `runnerDbDump` returns name, card number, club, birth year and sex for the whole directory.
  - `generateEvent` creates events and up to 2,000 runners.
- **Fix (S):**
  - Use `authedProcedure` for all of them, and `adminProcedure` for `syncRunnerDb`, `fetchEntryHistory` and `generateEvent`.
  - Add a test that allow-lists the intended public procedures.
  - Also check `event.select` (`event.ts:198`), `mapImport.review` (`:131`) and `exportCrt` (`:207`). They are public and their internal guards were not checked.
- **Status:** confirmed from code.

### MC-27 Recreating a deleted event's slug fails with a raw unique-constraint error; some slugs are silently unreachable
- **Area:** multi-competition (event identity). **Category:** functional.
- **Severity:** medium for the P2002, low for the slugs.
- **Location:**
  - `packages/api/src/routers/event.ts:255-264`: the check `existing && !existing.removed` passes for a removed event.
  - `schema.prisma:100`: `nameId @unique`, with no partial index.
  - `packages/api/src/db.ts:108-112`: the reserved slugs.
  - `docker/nginx.conf:17, 27, 45`: prefix locations without a trailing slash.
- **What is wrong:**
  - Deleting the test event "KM 2026" and creating it again gives an opaque 500, and the slug stays blocked until an admin purges it.
  - nginx prefix-routes `/api`, `/trpc` and `/assets`, so any slug starting with those letters (for example `api_cup`) is routed away from the SPA. `clubs` is shadowed by `web/public/clubs`.
  - The reviewer's claim about `/dev` was wrong: those routes exist only in dev builds.
- **Fix (S):**
  - Return CONFLICT with a "purge or restore" message, or rename the removed row's slug at delete time (`<slug>__deleted_<id>`). Do the same in `importEvent` (MC-13).
  - Reserve by prefix, or change nginx to `location /api/` and `location /trpc/`, and reserve `clubs`.
- **Status:** confirmed from code.

### MC-28 Soft-deleted events keep polling ROC and pushing to LiveResults
- **Area:** multi-competition (background jobs iterating events). **Category:** functional.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/online-input/puller.ts:432-462`: reconcile reads only `settings`.
  - `puller.ts:183-187`: `pollOnce` does not check `removed`.
  - `packages/api/src/liveresults.ts:736-738`: `where: { liveresultsTavid: { not: null } }`.
  - Soft delete at `routers/event.ts:328-331`.
  - Both run from `background/supervisor.ts:50-51`.
- **What is wrong:**
  - A deleted test event keeps inserting ROC punches and journal rows, and keeps publishing to public LiveResults until it is purged.
  - After a purge the `online_input_<id>_config` row is orphaned with `enabled: true`, and its timer keeps firing for ever.
- **Fix (S):**
  - Add `removed: false` to the LiveResults query.
  - Intersect the puller's reconcile with non-removed events.
  - Disable both on soft delete, and delete orphaned settings rows on purge.
- **Status:** confirmed from code.

### MC-29 The LiveResults `tavid` is settable through the API with no uniqueness check, so two events overwrite each other's results
- **Area:** multi-competition. **Category:** functional / cross-competition.
- **Severity:** medium (needs a direct API call; the UI never sends `tavid`).
- **Location:**
  - `packages/api/src/routers/liveresults.ts:113, 132, 229, 235`.
  - `packages/api/src/liveresults.ts:229-231, 353-356, 402-414, 427-497`: deletes and upserts are keyed by tavid plus the per-event `seq`.
  - `schema.prisma:115`: no unique constraint.
- **What is wrong:**
  - Runner `seq` starts at 1 in every event, so dbids collide.
  - The tavid can also point at another organiser's MeOS competition on the shared LiveResults MySQL, and the pusher then deletes and overwrites their rows.
- **Fix (S):**
  - Drop `tavid` from both inputs and delete `setConfig`, which claims to have no UI caller.
  - Add a partial unique index on `liveresults_tavid`.
  - Skip the pusher when another node holds the event's lease.
- **Status:** confirmed from code.

### MC-30 Every ROC config write is a whole-blob read-modify-write that can roll back the `lastId` watermark and duplicate punches
- **Area:** found here *(other area: readout/radio)*. **Category:** stability (race).
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/onlineInput.ts:51-70`, with callers at `:113-221`.
  - `packages/api/src/online-input/puller.ts:104-118` (compare-and-set) and `:251-269` (insert with no dedupe).
  - `schema.prisma:1052-1054`: `punches` has only non-unique indexes.
- **What is wrong:**
  - A config edit that coincides with a poll restores the older `lastId`. The next poll re-fetches that range and inserts the punches again.
  - Duplicates shift the visit count in `encodedRadioPunches` (`liveresults.ts:137-139`).
  - `clearLastId` re-importing everything is documented ("duplicates may appear", `en/event.json:224`), so it is not counted as a bug here.
- **Fix (S):**
  - Update single keys with `jsonb_set`, as `advanceWatermark` already does, or keep `lastId` in its own row.
  - In `pollOnce`, skip a punch whose `(eventId, cardNo, controlCode, time)` already exists.
- **Status:** confirmed from code.

### MC-31 The LiveResults pusher has no overlap guard and makes one round trip per row; cycles overlap at 2,000 runners
- **Area:** found here *(other area: LiveResults / performance)*. **Category:** performance / stability.
- **Severity:** medium; possibly high for large events.
- **Location:** `packages/api/src/liveresults.ts`:
  - `:580-593`: `setInterval(run)` with no busy flag (compare `puller.ts:318-320`);
  - `:358-376, 417-501`: one awaited statement per row;
  - `:475-484`: one punch query per runner with radio controls;
  - `:177-188`: an HTTP POST every cycle with no timeout;
  - `:204`: a pool of 5.
- **What is wrong:**
  - 2,000 runners means about 4,000 to 6,000 sequential round trips. At 50 ms each that is over 200 s against a 30 s interval.
  - Up to five cycles run at once, the rest queue without bound, and an older cycle can write stale times after a newer one.
- **Fix (M):**
  - Add an in-flight guard.
  - Load radio punches in one query.
  - Use multi-row `INSERT … ON DUPLICATE KEY UPDATE` (about 500 rows per statement).
  - Keep a per-event hash per runner and send only changes.
  - Add a timeout on `fetchConnectionString`.
- **Status:** confirmed from code. The timing is estimated, not measured.

### MC-32 Graphics import on checkout deletes by global id and can destroy another local event's graphic
- **Area:** multi-competition / venue-cloud. **Category:** cross-competition data loss.
- **Severity:** medium (needs a box-local event with graphics, or checkouts from two clouds).
- **Location:**
  - `packages/api/src/sync/snapshotGraphics.ts:254-268`: `tx.graphic.deleteMany({ where: { id } })`.
  - The replacement is specified in `docs/map-storage.md:1617-1620` (decision G18), but the spec and `lease.test.ts:846` consider only a stray club row.
- **What is wrong:** if event B on the box owns graphic id 3 and the checked-out cloud event A also has id 3, B's row is replaced by A's bytes under A's event id. B's sheets then show `IMAGE_MISSING`, and B's bytes are gone.
- **Fix:** either fail the checkout with a typed error when the held row belongs to another non-null event (S), or remap the row to a fresh id and rewrite the references (M-L). Either way this deviates from spec decision G18, so it needs Marcus's decision and a decision-log row.
- **Status:** confirmed from code.

### MC-33 `tracks.deleteRoute` deletes a GPS route of any event by global id
- **Area:** multi-competition. **Category:** security / cross-competition write.
- **Severity:** medium. The data is GPS tracks, not results; ids are sequential and guessable in proxy mode.
- **Location:**
  - `packages/api/src/routers/tracks.ts:78-83`.
  - `schema.prisma:1628`: `Route.id` is a global autoincrement.
  - The sibling `getRoutePreview` (`:92-104`) does check the event. The file header saying "Read-only" is stale.
- **Scenario:** a user with `event.manage` on event A loops `tracks.deleteRoute({ routeId: n })` over n and deletes every event's routes. A missing id gives a raw P2025 500.
- **Fix (S):** `deleteMany({ where: { id, eventId: ctx.event.id } })`, and NOT_FOUND when the count is 0. Add a two-event integration test.
- **Status:** confirmed from code.

### MC-34 Eventor entries without a PersonId collapse onto one runner on every later sync
- **Area:** found here *(other area: Eventor)*. **Category:** functional / data corruption.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/eventor.ts:738`.
  - `packages/api/src/routers/eventor.ts:794, 984-986, 1001, 1118, 1140`.
  - `schema.prisma:847`: an index only, no unique constraint.
- **What is wrong:**
  - Each id-less entry is created as its own runner, with `eventorPersonId: 0n`.
  - On later syncs, `byPersonId.get(0)` resolves to a single runner, and every id-less entry overwrites it in turn (name, class, club, card).
  - The `person:0` owner key also lets those entries take each other's card numbers in `makeCardNoClaimer`, which can hit the `(event_id, card_no)` unique index.
- **Fix (M):** store `null` when the personId is 0 or less, and match those entries by `eventorEntryId`.
- **Status:** mechanism confirmed from code. That Eventor emits individual entries without a PersonId is plausible but was not checked against a real payload.

### MC-35 `eventor.sync` writes runners and classes with no lease guard and no journal
- **Area:** found here *(other area: Eventor)*; affects the venue/cloud boundary. **Category:** stability / divergence.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/eventor.ts:903` (`manageProcedure`).
  - `packages/shared/src/cloud-ownership.ts:18`: `eventor.` is cloud-owned, so a venue forwards it.
  - Documented as "unsupported" against a leased event in `docs/system/offline-architecture.md:186-188`.
- **What is wrong:** nothing enforces "unsupported". A sync forwarded during a lease changes the cloud's runner rows, which `:153-158` says are venue-owned. The box never sees the change.
- **Fix (S):** call `assertRaceWritable` in `sync`, so it fails with the typed PRECONDITION_FAILED while the event is leased.
- **Status:** confirmed from code.

### MC-36 Background route and climb refreshes, and other non-race paths, journal course and control rows outside the lease guard
- **Area:** multi-competition / venue-cloud. Applies to PR254 and to main. **Category:** stability / sync correctness.
- **Severity:** medium.
- **Location:**
  - PR254: `packages/api/src/trpc.ts:170-185` (the new `eventProcedure` middleware); `course-climb.ts:97-147`; `leg-routes-auto.ts:168-239`.
  - main: `routers/course.ts:1530, 1562, 1590` (`applyUploadedMap`, `setMapRotation`, `useClubMap`), which call `refreshDerivedCourses` (`event-map.ts:66-78`), which emits `course.upserted`.
  - main: `routers/control.ts:1438, 1483-1491` (`upsertConfig`, which journals `control.upserted`). Its unit write at `:1495-1517` is outside that transaction.
- **What is wrong:** `appendJournal` and `emitCourseUpserted` do not check the lease. When the cloud is not the lease holder, a course-object move or a map apply there emits full-row last-write-wins `course.upserted` entries while the venue owns reference data (`offline-architecture.md:165`). PR254 widens a gap that already exists on main.
- **Fix (S-M):**
  - Check `isRaceWritable` before computing in the PR254 middleware and background refresh; skip, do not throw.
  - Move `upsertConfig` and the map paths to race procedures, or skip their emit when the node is not the holder.
- **Status:** mechanism confirmed from code. The harm on the venue side of the merge was not traced.

### MC-37 `control.list` reads `course_controls` for every event in the database
- **Area:** multi-competition (query missing event scope). **Category:** performance.
- **Severity:** medium on a cloud instance, low on a laptop.
- **Location:** `packages/api/src/routers/control.ts:591-593`. `CourseControl` has no `eventId` column (`schema.prisma:541-559`).
- **What is wrong:**
  - There is a full-table read on every Controls page load. Nothing leaks, because rows are joined to this event's controls in memory.
  - Runner counts include classes that still point at a removed course: `course.delete` (`course.ts:1198-1213`) soft-deletes without unlinking.
- **Fix (S):** `where: { course: { eventId, removed: false } }`, the same fix `controlCompletionStatus` already has.
- **Status:** confirmed from code.

### MC-38 `importCourses` with "replace all" wipes first and writes the rest outside any transaction
- **Area:** found here *(other area: course pipeline)*. **Category:** stability / partial write.
- **Severity:** medium; high if it happens on event morning.
- **Location:**
  - `packages/api/src/routers/course.ts:1883-1898`: the wipe.
  - The writes run through `:2341`; the only transactions are single-row code allocations at `:2066` and `:2094`.
  - The intent is documented at `:2318-2325`.
- **What is wrong:**
  - The documented intent covers a crash that "loses only the ship". It does not cover a throw mid-import with `replaceAll`.
  - Such a throw leaves classes without courses and courses and controls removed, and peers are never told.
- **Fix (M):** parsing already happens before the wipe. Run the wipe, the writes and the journal emit in one `$transaction` with a raised timeout, as `layout.autoSheets` does.
- **Status:** confirmed from code.

### MC-39 Backup punches can be pushed or imported twice
- **Area:** found here *(other area: SI readout)*. **Category:** functional.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/control.ts:1765-1810` (`pushBackupPunch`, with no `isOriginal`/`source` check).
  - `control.ts:1824-1903` (`importBackupPunches` mints a `uuidv7()` per row at `:1866`, so `skipDuplicates` never fires).
  - `ControlsPage.tsx:1540`: `autoClear` is off by default.
- **Scenario:** a station is read twice without being cleared. Its whole backup memory is imported again, with one `punch.recorded` per duplicate.
- **Fix (S-M):**
  - Guard push on `source === "backup_memory" && isOriginal`.
  - Dedupe the import on `(eventId, cardNo, controlCode, time, unitId, source)`, through a unique index or a pre-query.
- **Status:** confirmed from code.

### MC-40 Dexie `projRunners` primary key has no event (latent, behind a dev flag)
- **Area:** multi-competition (web). **Category:** functional.
- **Severity:** medium. Latent: the projection is behind a localStorage flag that is off by default (`feature-flags.ts:9-10, 20-26`). It becomes high at the read cutover.
- **Location:**
  - `packages/web/src/lib/offline/db.ts:209-210`.
  - `projection.ts:40-46`: keys `card:<n>` and `id:seq:<n>`.
  - `projection.ts:233-241`: delete by competition, then `bulkPut`.
- **What is wrong:**
  - Hydrating event B overwrites event A's rows for runners that share a card number or seq.
  - The same key also collapses two runners in one event who share a reused rental card (`:69-72`).
- **Fix (S):** a Dexie v5 schema change that rebuilds the table with key `${competitionId}:…` or the compound `[competitionId+key]`. Add a `projection.test.ts` case with two competitions that share a card.
- **Status:** mechanism confirmed; impact downgraded by the verifier.

### MC-41 `cardReadout.cardDetail` reads the wrong punch shape, so the card panel shows no control codes
- **Area:** found here *(other area: SI readout)*. **Category:** functional (display).
- **Severity:** medium.
- **Location:** `packages/api/src/routers/cardReadout.ts:1122-1171`. The writer is at `:516-521` and the schema at `:395-402`. The consumer is `packages/web/src/pages/CardsPage.tsx:375, 673-735`.
- **What is wrong:** punches are stored as `{ controlCode, time }` but read as `{ type, time }`. The "Control" column is blank for every row, and the check, start and finish rows never show. Stored data and results are unaffected.
- **Fix (S):** read `controlCode`, and take check, start and finish from the Card row (`card_readouts` has no such columns). Add a test.
- **Status:** confirmed from code.

### MC-42 `draw.execute` is not atomic, and start numbers never reach peers
- **Area:** found here *(other area: draw / sync)*. **Category:** stability; sync gap.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/drawRouter.ts:157-199`: one transaction per runner at `:164` and per class at `:188`.
  - The payload at `:173-180` has no `startNo`.
  - `routers/events.ts:430-443` applies `startTime` only.
- **What is wrong:**
  - A failure mid-loop leaves a partly drawn start list. Re-running the draw recovers it locally.
  - On the cloud or the peer, start lists lack start numbers.
- **Fix (M):** run the draw in one transaction with a raised timeout, and add `startNo` to the payload and to the apply.
- **Status:** confirmed from code.

### MC-43 `club.detail({ id: 0 })` returns every runner of the event, and all free-text clubs share key 0 in the UI
- **Area:** found here *(other area: API routers)*. **Category:** functional.
- **Severity:** medium (wrong data shown, within one event).
- **Location:** `packages/api/src/routers/clubRouter.ts:68-74` and `:88-99`; `packages/web/src/pages/ClubsPage.tsx:120, 122, 205`.
- **What is wrong:** with id 0 no club filter is applied, so the response holds every runner of the event. Expanding one free-text club expands all of them, and each shows the whole field.
- **Fix (S):** give free-text clubs a name-based key in `list` and `detail`.
- **Status:** confirmed from code.

### MC-44 `tracks.listRoutes` loads every route's waypoint JSON
- **Area:** found here *(other area: tracks / performance)*. **Category:** performance.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/routers/tracks.ts:15-22`: `include` with no `select`; the response does not use waypoints.
  - `tracks.ts:121-150`: `getClassRoutes` without a `classId` (or with 0, which is falsy at `:125`) returns all waypoints of the event. It has no web caller.
- **Fix (S):** add an explicit `select` in `listRoutes`. Require `classId` in `getClassRoutes`, or delete it.
- **Status:** confirmed from code.

### MC-45 `eventorFetch` has no timeout
- **Area:** found here *(other area: Eventor)*. **Category:** stability on a poor network.
- **Severity:** medium.
- **Location:** `packages/api/src/eventor.ts:219-221`.
- **What is wrong:** undici's defaults apply, so each call can hang for about 5 minutes. `sync` and `importEvent` make several calls in sequence.
- **Fix (S):** `signal: AbortSignal.timeout(30_000)`, with the abort mapped to a clear TRPCError.
- **Status:** confirmed from code; the reviewer's "unbounded" was corrected to about 5 minutes.

### MC-46 No test covers cross-event isolation on the paths that take global ids or the event header
- **Area:** multi-competition. **Category:** tests.
- **Severity:** medium.
- **Location:**
  - `packages/api/src/__tests__/integration/course.test.ts`, `control.test.ts` and `events-push.test.ts` each create a single event.
  - `e2e/offline.spec.ts` uses one competition.
  - `packages/web/src/__tests__/trpc-cache-scope.test.ts` only tests string concatenation.
  - Good examples to copy: `map-gps-tracks.test.ts:186-200`, `graphics.test.ts:172`, `course-objects.test.ts:293-299`.
- **What is wrong:** routers that address rows by per-event `seq` are naturally safe. The paths that are not safe (`events.push` payloads, UUID or global-id inputs such as `tracks.deleteRoute`, reference upserts) and the client's per-event state have no tests.
- **Fix (M):**
  - Add a parametrised integration test with two events that share seqs and card numbers, covering `events.push` (MC-01, MC-07, MC-20) and `tracks.deleteRoute`.
  - Add a two-competition e2e test covering MC-01, MC-04, MC-05 and MC-18.
- **Status:** confirmed by grep. Not every test body in the roughly 80 integration files was read.

---

## Low

### MC-47 "Make maps available offline" builds its query list from the URL's event, not the requested one
- **Location:** `packages/web/src/print/offline-prepare.ts:76-99`. The `nameId` argument is only echoed back at `:94`; the call is at `:262`. Callers are `useOfflineMaps.ts:74-91` and `LayoutMode.tsx:105-113`.
- **What is wrong:** a mismatch needs a navigation between the click and line 262. The window is real, because `ensure` first awaits two `autoSheets` mutations. B's course seqs are then requested under A's print-job URL, and pruning may drop A's stored entries (inferred, not read).
- **Fix (S):** use the per-event client from MC-01 for these queries.
- **Status:** confirmed from code.

### MC-48 The sync secret is compared with `!==`, and the `eventProcedure` comment is wrong
- **Location:** `packages/api/src/trpc.ts:198`. The comment at `:160-161` says NOT_FOUND; the code returns BAD_REQUEST at `:145-149`.
- **Fix (S):** reuse `kioskKeyMatches` (`timingSafeEqual`) for the secret, and correct the comment.
- **Status:** confirmed from code.

### MC-49 Club graphics can be deleted from any event while other events still use them
- **Location:** `packages/api/src/routers/graphics.ts:160-174`. This is documented design (`docs/course-maps.md:168-170`, `docs/course-layout.md:250-252`).
- **What is wrong:** a `courses.edit` holder on event X deletes a club sponsor logo, and event Y's prints show `IMAGE_MISSING`. Club templates (`mapTemplate.deleteClub`) are copied into the event on load, so deleting one is harmless.
- **Fix (M):** refuse the delete while the graphic is referenced, by scanning `course_maps.objects`, `map_templates.objects` and `course_objects.props`. This is a product decision for Marcus.
- **Status:** confirmed from code.

### MC-50 The backup stream ignores backpressure
- **Location:** `packages/api/src/backup.ts:296`, with the routes at `:341-394`, a copy-pasted pair.
- **What is wrong:** a slow client buffers the whole dump in the API heap. Map blobs are hex, about twice their binary size. A node reproduction buffered 65 MB from ignored writes. A client abort is harmless: psql runs to the end.
- **Fix (S):** `dump.stdout.pipe(out, { end: false })`, kill the child on `out.on("close")`, and register one handler for both paths.
- **Status:** confirmed from code and a node one-liner.

### MC-51 The map-document `accessCache` never evicts
- **Location:** `packages/api/src/map-store/routes.ts:180-185, 235`. With AUTH_MODE=off, the handler returns ok at `:136` and the entry is still cached.
- **What is wrong:** the key includes caller-supplied `kioskKey` and `event` strings, so a client can grow the cache without bound by varying them.
- **Fix (S):** skip the cache when auth is off, keep the kiosk key out of the key unless it was the grant reason, and use the existing `LruCache`.
- **Status:** confirmed from code.

### MC-52 Eventor caches are keyed without the environment, and the key store never refreshes
- **Location:**
  - `schema.prisma:399-425`;
  - `packages/api/src/routers/eventor.ts:709, 1913-1937, 1965-1986`;
  - `packages/api/src/eventorKeyStore.ts:58-87`.
- **What is wrong:**
  - A test-Eventor fetch overwrites, or is served as, the production row with the same id. This affects only trend, pace and event-list metadata.
  - The key store's `loaded` latch never refreshes across cloud instances.
- **Fix (S):** add `env` to the keys, and give the key store a TTL re-read.
- **Status:** confirmed from code.

### MC-53 `applyEventMap` replaces the event's map row outside a transaction
- **Location:** `packages/api/src/event-map.ts:139-148`; callers are `routers/course.ts:1544` and `:1619`. `map_files` has no unique constraint on `event_id` (`schema.prisma:1265`).
- **What is wrong:** a failure between the delete and the create leaves no map row (the pin and rotation are lost; a re-upload recovers). A concurrent apply leaves a stale extra row; readers use `findFirst` on the newest row.
- **Fix (S):** wrap the delete and create in `$transaction`, or upsert on a new unique `(event_id)`.
- **Status:** confirmed from code.

### MC-54 Small course-router edge cases
- **Location:**
  - `packages/api/src/routers/course.ts:1139-1142`: `bulkUpdate` has no `removed: false`, and unknown ids are dropped silently.
  - `course.ts:1402-1412`: `controlCompletionStatus` returns the all-courses aggregate for an unknown or removed courseId.
  - `course.ts:275-297`: `controlSeqToId` loads every control of the event once per id; it is called through `Promise.all` at `:603, :837`.
- **Fix (S each):**
  - Add the `removed` filter and return NOT_FOUND when counts mismatch.
  - Return `[]` when a courseId was given but not found.
  - Resolve all ids in one query.
- **Status:** confirmed from code.

### MC-55 `cardReadout.addPunch` matches control codes by substring
- **Location:** `packages/api/src/routers/cardReadout.ts:1306-1313`.
- **What is wrong:** `contains: "31"` matches the codes "131", "310" and "231;45", so a wrong `punch.controlId` is stored. Nothing reads that column today; matching goes by `controlCode`.
- **Fix (S):** reuse the exact-match pattern from `control.ts:166-171`.
- **Status:** confirmed from code.

### MC-56 A runner card-number race surfaces as a raw 500 instead of CONFLICT
- **Location:** `packages/api/src/routers/runner.ts:146-168`, called at `:420` and `:532`.
- **What is wrong:** the reviewer's data-integrity claim was refuted: the partial unique index `runners_event_id_card_no_key` (migration `20260601120000_runner_card_no_nullable`) holds. The loser of the race gets a raw Prisma P2002.
- **Fix (S):** catch P2002 in create and update, and map it to the same CONFLICT message.
- **Status:** confirmed from code.

### MC-57 `club.logoMap` loads every logo blob only to test that it is non-empty
- **Location:** `packages/api/src/routers/clubRouter.ts:245-270`. It is called from `ClubLogo.tsx:30`.
- **Fix (S):** filter `smallLogoPng: { not: null }` and select only `eventorId`.
- **Status:** confirmed from code.

---

## Checked and clean

- **Per-router event scoping:** runner, cardReadout, race, class, lists, draw, external, permission, liveresults (router), onlineInput, course, control, courseMap, courseObject, controlSeries, layout, graphics, classPreset, mapTemplate, mapPatch, mapTrack, mapImport, clubMap, demSettings and mapStorage. Every id from input is resolved as `(eventId, seq)`, or checked against `ctx.event.id` after a UUID lookup. The only exceptions are listed above (MC-33, MC-37).
- **REST routes:** `assertRestAccess` resolves, authorises and returns the same event for backup, course export, maps.pdf, print-job, descriptions.pdf, graphics and patch. Map document, preview, heightfield, source and upload routes authorise against the pin of the event the caller names. Blobs are content-addressed, and sharing them follows `docs/map-storage.md` §4.2.
- **Module-level caches:** keyed by event id or by content hash: `webhookCache`, LiveResults tenants, the puller registry, `simulations`, the `event-map-objects` memo, the `event-document` LRUs, previews, heightfield, `mapRefresh.running`, and `clubMemberCache` (env + org). `resolveEvent` is not cached. PR254's `running` queue and its climb marks (AsyncLocalStorage) are keyed per event and per request.
- **Web:**
  - the service-worker tRPC cache is partitioned by `&event=<nameId>`;
  - BroadcastChannels are per event;
  - localStorage keys are device preferences or carry a nameId suffix;
  - Dexie tables other than `projRunners` are keyed or filtered by `competitionId`;
  - raw `fetch` calls carry the event header or path.
- **PR254** adds nothing new to this area beyond MC-36. Its `backup.ts`, `referenceJournal.ts` and `sync/lease.ts` diffs are consistent with the schema.

## Not reviewed, or could not be verified

- Nothing ran against a database. No Postgres was available in the container, and the brief kept runs to the ones that settle a question. The psql exit-code behaviour (MC-11) and the TanStack pause/resume behaviour (MC-16) are reasoned from the documented semantics of the pinned versions.
- **Whether venue→cloud journal push works behind IAP / proxy mode today:** `events.push` needs an invited user, and the shipper sends only the sync secret. Answer this with a two-node run before fixing MC-03.
- How a non-lease-holder's `course.upserted` merges on the venue during a lease (MC-36). The direction of the apply was not traced.
- Whether Eventor sends individual entries without a PersonId (MC-34).
- **Not read at all:** `KioskPage`, `StartScreenPage`, `print/offline-store.ts`, the map-gl worker, `map-store/dem-*`, `gc.ts`, `previews.ts`, `blob-store.ts`, `print-worker.ts`, `import-worker.ts` and `course-import-align.ts`.
- **Read in part:** most of `eventor.ts`, past fetch, entries and results; `applyEvent` in `routers/events.ts`, past what the findings needed; the bulk of `CompetitionShell.tsx` JSX; and PR254's `EditorPage.tsx`, which was grepped, not read line by line.
- `routers/fictional-names.ts` was checked only for its export list (static data, no DB access).
- `vite.config.ts:67-70` was noticed but not verified: `NetworkFirst` with a 3 s timeout on every tRPC GET can serve a cached `cardReadout.readout` from before the store that just happened, on a slow network. This belongs to the offline-sync area.

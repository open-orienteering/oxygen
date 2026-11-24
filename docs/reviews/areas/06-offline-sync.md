# Area 06: Offline sync, restart safety and outbound publishing

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Reviewed on `main` at `df5460c3`, plus the PR 254 diff (`claude/project-thread-avzbks`) where it touches this area. Review only: no code was changed.

**Scope:** lease checkout and checkin; journal shipping (the shipper, the HLC clock, `events.push` and `events.since` ingest); the venue forwarder; snapshot import and the map and settings refresh; backup and restore; process startup and shutdown; the leader lease and the background supervisor. On the station side: the offline queue (outbox, local readout, projection, query-cache persister, service worker, node discovery). Outbound publishing: the LiveResults pusher, the ROC online-input puller and the Google Sheets backup. Logging across all of these.

**Method:** two Fable reviewers read the area in full (one for the server side, one for the station side plus publishing), which gave 48 raw findings. 29 fresh Fable verifiers plus one follow-up were each given only the locations and claims, never the reviewer's reasoning, and told to disprove them. Critical and high claims got one verifier each; medium claims were paired and low claims grouped five per verifier, to stay within agent limits, and each claim was judged on its own. Overlapping claims from the two reviewers were merged (A4 with B5, A5 with B4). Two cheap reproductions ran on a throwaway local Postgres 16 (not the dev database): backup psql error swallowing (SYNC-09) and the ROC unique-index stall (SYNC-05). One Node reproduction covered backup stream buffering (SYNC-36). `node_modules` was absent, so no vitest, integration or E2E run was possible; everything else is from reading code.

**Result:** B13 as originally stated was refuted and dropped: ROC duplicates cannot occur, because the partial unique index `punches_oi_dedup_idx` exists in every migrated database. The same triggers cause a worse failure, restated and confirmed as SYNC-05. A17's zero-time/date and teams sub-claims were refuted (no code writes them at the venue). One A22 doc item about `nodeIdentity.ts` was refuted. B2's corruption step (another competition's cached result queued and applied on the server) does not happen today, only because the emit it relies on is dead code (SYNC-03). After the merges this leaves 46 findings.

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 15 |
| Medium | 17 |
| Low | 12 |

**Fix first:**
1. **SYNC-01:** journal shipping uses the HLC as its cursor, so a station entry that arrives late is never shipped to the cloud, and the checkin barrier still reports "all shipped".
2. **SYNC-02:** sequence counters never return to the cloud after a lease, so after checkin every new runner, class, course or control on the cloud fails, and a second checkout carries the same stale counters back to the box.
3. **SYNC-03 together with SYNC-19:** a standalone kiosk silently drops card readouts when the node is unreachable, and the offline `result.applied` emit is dead code; fixing that emit without scoping the query cache by competition turns SYNC-19 into server-side corruption.
4. **SYNC-04:** `events.push` lets any signed-in user write to any event, ignores each entry's own competition, and can overwrite another event's classes, courses and controls by UUID.
5. **SYNC-05:** pressing "clear last id" on the ROC panel (or a config save racing a poll) stops all radio-punch intake for the rest of the event.

Quick wins: SYNC-06 is a one-line S fix (same defect as RES-07 in area 04; fix once), SYNC-09 needs `ON_ERROR_STOP` plus the `event_log` rename, and SYNC-13 is a storage-key mismatch.

---

## Critical

### SYNC-01 Journal shipping skips entries that land below the `(hlc, id)` watermark, and the checkin barrier cannot see them
- **Area / category:** journal shipping; stability (silent data loss).
- **Location:**
  - `packages/api/src/sync/shipper.ts:195-201` (push page) and `:215-219` (watermark set to the last acked `(hlc, id)`); pull cursor `:231-254`.
  - `packages/api/src/routers/events.ts:195-203`: the page query is `hlc > after OR (hlc = after AND id > afterId)`.
  - `packages/api/src/routers/events.ts:110-134`: ingest stores the sender's HLC; `foldServerHlc` at `:119` only raises the node clock.
  - `packages/api/src/journalEmit.ts:59`: the HLC is taken inside the caller's open transaction.
  - `packages/api/src/serverClock.ts:19`: the clock is in memory and starts at `HLC_ZERO`.
  - Barrier: `packages/api/src/sync/lease.ts:391-401` (`shippingStatus`, same predicate) and `packages/api/src/routers/lease.ts:240-246`.
  - Station stamping: `packages/web/src/lib/offline/events.ts:22-30,58-59`; drain `packages/web/src/lib/offline/sync.ts:35`.
- **What is wrong:** the shipper ships "entries after the last acked `(hlc, id)`". That is correct only if journal rows become visible in HLC order, and they do not:
  1. **Late station entries.** A station stamps the HLC with its own clock when it queues the entry, and drains later. Ingest keeps that stamp. If the venue has shipped anything stamped later in the meantime, the row is inserted below the watermark and is never selected. A station whose clock is merely slow does the same with no outage.
  2. **Commit order.** The stamp is taken before commit, so a transaction stamped earlier can commit after a later one has been shipped and acked. In `storeReadout` the stamp comes near the end of the transaction, so the window there is milliseconds; wider windows exist where the stamp is taken before the work (`routers/course.ts:2308`, `referenceJournal.ts:132,152`, `course-objects.ts:37`, `map-store/patches.ts:54`, `gps-tracks.ts:226`).
  3. **Clock regression after restart.** Nothing seeds the clock from the journal at boot. After a restart, entries are stamped below the persisted watermark until wall time passes it (clock stepped back) or until the fast station that had been folded in pushes again. Entries minted in that window are skipped for good. The comment at `serverClock.ts:11-14` is wrong with respect to the watermark.
- **Scenario:** a finish station loses Wi-Fi for 40 s and queues `finish.recorded` for card 501 at 11:02:10. Meanwhile readouts are shipped up to 11:02:45. The station reconnects and drains; the venue applies the finish (arena results are right) and journals it at 11:02:10, below the watermark. `pendingPush` stays 0, checkin succeeds, the box is switched off, and the cloud never gets that finish. Nothing else carries it, because `finish.recorded` emits no server-stamped follow-up (`events.ts:352-366`). A later re-checkout then cascades away the venue's only copy (`sync/lease.ts:297-300`). The pull direction has the same hole for station entries pushed straight to the cloud with an older stamp, and for the checkout `journalCursor` (`sync/lease.ts:277-289`).
- **Fix (M–L):**
  - Stop using the HLC as the ship cursor. Simplest robust form: a nullable `pushed_at` column on `journal`, ship `WHERE pushed_at IS NULL ORDER BY hlc, id`, set it on ack, and count NULLs for `pendingPush`.
  - Alternatively, a `local_seq BIGSERIAL` cursor shipped only up to a safe horizon (compare the row's `xmin` with `pg_snapshot_xmin(pg_current_snapshot())`, or take a per-event advisory lock in `appendJournal`, ingest and the shipper read). For pull, page `events.since` by the server's `local_seq`.
  - Seed `serverClock` at boot from `MAX(hlc)` of the journal.
  - Integration tests: an entry ingested below the watermark ships; two overlapping transactions; a restart with the clock behind.
- **Verdict:** confirmed from code reading. Mechanism 1 is proven step by step; mechanisms 2 and 3 hold but are narrower than stated (the readout-transaction window is short; the fast-station case heals at that station's next push). The cited `journalEmit.ts:406` does not exist; the stamp is at `:59`. ROC punches were cited as a pull example but carry a fresh cloud stamp (`online-input/puller.ts:270`), so they are exposed only through mechanisms 2 and 3. No test covers a late or low-HLC insert (`journal-shipping.test.ts:120-421`), and `docs/system/offline-architecture.md:317-319` ("a watermark never skips past an unapplied entry") states an invariant the code does not have. (reviewer A1)

### SYNC-02 `event_seqs` counters never travel back to the cloud, so cloud inserts collide after checkin and a re-checkout carries the stale counters back to the box
- **Area / category:** lease checkin and takeover; functional (event-stopping).
- **Location:**
  - `packages/api/prisma/migrations/20260517_init/migration.sql:141-155`: `allocate_event_seq()` advances `next_seq` only when `NEW.seq` is NULL or 0; never redefined.
  - Explicit-seq inserts on the follower: `packages/api/src/routers/events.ts:504-507` (runners) and `:858-863` (control, course and class upserts).
  - `packages/api/src/routers/lease.ts:224-252` (checkin moves only the journal) and `:260-281` (`forceTakeover`).
  - Snapshot export and import of counters: `packages/api/src/sync/lease.ts:272-275` and `:320,356-360`.
  - Doc: `docs/system/offline-architecture.md:268-276` ("At checkin the counters travel back with the barrier").
- **What is wrong:** while the venue holds the lease it allocates seqs. The cloud applies those rows with explicit seqs, which leaves its `event_seqs.next_seq` untouched, and nothing at checkin or takeover raises it. The next cloud-side insert gets the pre-checkout value, which is now taken, and fails on `UNIQUE (event_id, seq)`. The trigger's counter bump is in the failing statement, so it rolls back and every retry fails the same way. No P2002 retry exists around these creates.
- **Scenario:**
  - Checkout with 400 runners (`next_seq` 401). 60 direct entries are registered at the venue (seq 401 to 460). After checkin, or after a force takeover, every `runner.create` on the cloud fails with P2002 until `event_seqs` is fixed by SQL. The same applies to classes, courses and controls created at the venue.
  - Aggravation found by the verifier: on a second checkout (a two-day event, or a re-checkout after a takeover) the cloud exports its stale counters and the box recreates its counters from them. The first direct entry on day 2 takes seq 401 again and fails, so venue registration stops mid-event.
- **Fix (S–M):**
  - New migration: in `allocate_event_seq()`, when a seq is supplied, raise the counter with `GREATEST(next_seq, NEW.seq + 1)`, the same upsert `sync/mapRefresh.ts:303-306` uses for map tables. This covers checkin, takeover and re-checkout at once.
  - Fix the doc sentence.
  - Integration test: checkout, create a runner on the venue, ship, checkin, then `runner.create` on the cloud succeeds with the next seq; and a second checkout followed by a venue-side create.
- **Verdict:** confirmed from code reading (trigger body, every writer of `event_seqs` found by grep, no counter transfer at checkin or takeover). Not executed against a database. Proven for runners and for control, course and class upserts; cards, teams and control units were not traced. The verifier rated it high on the checkin path alone; it is raised to critical because the re-checkout path stops registration at the arena. `lease.test.ts:776-826` ends at "lease released" and creates nothing afterwards. (reviewer A2)

---

## High

### SYNC-03 A standalone kiosk drops card readouts when the node is unreachable, and the offline `result.applied` emit is dead code
- **Area / category:** station offline queue; stability (data loss).
- **Location:**
  - `packages/web/src/context/DeviceManager.tsx:252-253,268-270`: `competitionNameIdRef` starts `null`; `setCompetitionNameId` is its only writer.
  - `packages/web/src/pages/CompetitionShell.tsx:233,258`: the only callers.
  - `packages/web/src/App.tsx:95-96`: `/:nameId/kiosk` and `/:nameId/start-screen` are routed outside `CompetitionShell`.
  - `DeviceManager.tsx:358` (online store), `:408-417` and `:418-427` (queue guarded by the ref), `:519-529` (failed `applyResult`, same guard).
  - `DeviceManager.tsx:572-573`: reads the state `competitionNameId` inside `addRecentCard`, a `useCallback` with `[]` deps (`:313`, `:605`).
  - Drain: `useEventQueue` is used only by `components/SyncStatusIndicator.tsx:161`, mounted only at `CompetitionShell.tsx:460`.
- **What is wrong:**
  - On the kiosk route the ref is `null`, so when `storeReadout` fails or the browser is offline, `card.read` is neither stored nor queued. Only a `console.warn` remains. The kiosk route also mounts no queue drain and no pending or failed badge.
  - The offline local-readout branch reads a stale closure value that is always `null`, so it never emits `result.applied`, in any tab including the admin shell.
  - Re-reading the card does not repair it: the earlier read is still in `recentCardsRef`, so it is treated as a duplicate (`:317-320`) and skipped at `:358` and `:418`, although it was never stored.
- **Scenario:** a standalone kiosk tablet at the finish, Wi-Fi blips for 2 minutes, 15 runners read out. None of the 15 `card.read`s exist anywhere. Re-reading the same cards at the same tab is skipped as duplicate; recovery needs a reload, another device, or 20 newer cards. On a kiosk-only device the screen typically shows "register" or "pre-start" rather than a result (`computeCardReadout` needs a cached `runner.list`), but never says the readout was not saved.
- **Fix (M):**
  - Derive the competition for queued events from the URL (export `activeEventNameId()` from `lib/trpc.ts`), or have `KioskPage` and `StartScreenPage` call `setCompetitionNameId(nameId)`.
  - Replace `competitionNameId` at `:572-573` with the same source. Do this together with SYNC-19, or the A-cache corruption becomes real.
  - Do not mark a card as a duplicate unless it was stored or queued.
  - Mount `useEventQueue(nameId)` headless in `KioskPage` with a small pending or failed badge; if no competition can be determined, show an error instead of skipping.
  - Unit test `addRecentCard` with `storeReadout` rejecting in a kiosk-only tree; E2E `e2e/kiosk-readout.spec.ts` with `context.setOffline(true)`.
- **Verdict:** confirmed from code reading (grep shows `setCompetitionNameId` called only in the shell). The verifier narrowed "the kiosk shows a locally computed result" (that needs `runner.list` cached in the same browser profile within 24 h) and added the re-read-treated-as-duplicate aggravation. Rated high rather than critical because the punches remain on the SI card. (reviewer B1)

### SYNC-04 `events.push` has no capability check, ignores each entry's competition, and writes unvalidated fields, including cross-event upserts by UUID
- **Area / category:** journal ingest; security, cross-competition.
- **Location:**
  - `packages/api/src/routers/events.ts:229-240`: `eventProcedure` (`trpc.ts:167`, `authedProcedure` `:116-124`), no `requireCapability`.
  - `events.ts:88-151`: `ingestJournalEntries` applies everything to the header's event; `entry.competitionId` (`:69`) is never compared.
  - `events.ts:99-106`: idempotency by entry id alone, not per event.
  - `events.ts:843-915`: `applyReferenceUpsert` copies `payload.fields` verbatim into `upsert({ where: { id } })` for control (`:866-870`), course (`:875-879`) and class (`:898-902`); `courseControl.deleteMany` (`:881`) and `classCoursePool.deleteMany` (`:904`) by bare id. Also reachable in bulk through `reference.imported` (`:690-729`).
  - Payload validation is `z.record(z.string(), z.unknown())` (`:76`).
  - Client: `packages/web/src/lib/trpc.ts:22-31,65-75` (header read from the URL per request); `packages/web/src/lib/offline/sync.ts:5,21-37` (batch loop); `packages/web/src/hooks/useEventQueue.ts:51-75` (drain not cancelled on navigation).
  - `packages/api/src/auth.ts:132-141` (auto-provisioning); documented as intended in `docs/system/authentication.md:231`.
- **What is wrong:**
  - With `AUTH_MODE=proxy`, any authenticated user with no capability on an event can delete or alter its runners, finishes and statuses by pushing `runner.deleted`, `finish.adjusted` or `result.applied` (runners resolve by guessable card number or seq).
  - The same user can overwrite or soft-delete a class, course or control of **another** event by pushing an upsert with that row's UUID to an event named in the header: `where` has no `eventId`, which is forced only in `create`, and `fields` can carry `eventId` or `removed`. It can also wipe a foreign course's `course_controls`. `reference.imported` with `replaceAll` lets the user soft-remove every course and control of the header's event.
  - On the documented Cloud Run deploy, `AUTH_AUTO_PROVISION=member` creates a member for any email IAP admits, so "authenticated user" means any account IAP lets in (found while verifying SYNC-23).
  - Honest clients hit it too: the station drain filters by its captured competition, but the header is recomputed from the URL for every 50-entry batch. Navigating to another competition mid-drain sends A's remaining entries with header B. They are applied in B, acked `synced`, and a later retry to A answers "synced" without applying, because idempotency is global.
  - Every poisoned entry is journaled under the target event and ships to peers.
- **Scenario:**
  - A user of club X's competition pushes `control.upserted { id: <club Y control UUID>, fields: { removed: true } }` with their own event header; club Y's control disappears.
  - 120 queued entries for stage 1; the operator reconnects and immediately opens stage 2. Whatever batches are still in flight after the navigation are applied to stage 2 (finishes on whichever runner has that card) and are lost for stage 1.
- **Fix (M):**
  - Server: reject (as `failed`, "entry belongs to <x>") any entry whose `competitionId !== event.nameId`.
  - Split the sink: station drain requires `race.operate` (or the kiosk key) on the event; node-to-node push requires the sync secret (`peerProcedure`), and only that path may apply `*.upserted` and `reference.imported`.
  - In `applyReferenceUpsert`, look the row up first and throw when it belongs to another event; strip `id`, `eventId` and `seq` from `fields` and whitelist keys against the model's scalar fields (the same helper as SYNC-17).
  - Client: pass the header explicitly per drain and stop the loop when the active competition changes.
  - Integration tests in `events-push.test.ts`: push to event A cannot touch a row of event B; an entry for another competition is refused.
- **Verdict:** confirmed from code reading at main. Not executed. The runner and punch lookups by bare UUID (`events.ts:475-479`, `:594-599`) are read-only dedupe checks, so they are a minor suppression vector, not a cross-event write; `resolvePunch` (`:811-823`) is event-scoped. Moving a row via `fields.eventId` is read from Prisma's unchecked update input, not executed. The navigation race needs a client-side route change between competitions, which was not checked in the UI; the number of misapplied entries depends on timing. No impact with `AUTH_MODE=off`, where everyone already holds every capability. (reviewer A5, merged with B4)

### SYNC-05 "Clear last id", or a config save racing a poll, makes every ROC poll fail on the dedupe index, and radio intake stops for the rest of the event
- **Area / category:** ROC online-input puller; stability.
- **Location:**
  - `packages/api/src/routers/onlineInput.ts:190-195` (`clearLastId`, wired to a button at `packages/web/src/pages/EventPage.tsx:1043-1056`).
  - `onlineInput.ts:51-70,103-121`: every mutation does `loadConfig` then saves the whole JSON blob including `lastId`.
  - `packages/api/src/online-input/puller.ts:196,227`: the rewound `lastId` re-fetches already imported punches.
  - `puller.ts:247-283`: one transaction for watermark advance plus plain `tx.punch.create` (`:258-270`), no conflict handling.
  - `packages/api/prisma/migrations/20260517_init/migration.sql:542-543`: `punches_oi_dedup_idx` on `(event_id, card_no, control_code, time) WHERE source = 'online_input'`.
  - `puller.ts:322-328`: the tick only records the error.
- **What is wrong:** the first already-imported punch in the batch violates the unique index; the transaction rolls back, including the watermark advance and any new punches in the batch. `lastId` is unchanged, so every following tick fetches the same range and fails the same way. The only UI control resets `lastId` to 0, which is the jammed state. The config race does the same: a poll that commits between a router mutation's load and save has its watermark written back to the older value, and the next compare-and-set passes against it.
- **Scenario:** mid-event an operator presses "clear last id" on the Event page (enabled whenever `lastId > 0`), expecting at worst duplicates, as the tooltip says (`packages/web/src/i18n/locales/en/event.json:224`). From that moment no new radio punch is stored; the panel shows a raw database error on every tick. Recovery needs an SQL edit of the settings row.
- **Fix (S–M):**
  - Insert with conflict skipping (`createMany({ skipDuplicates: true })` or `INSERT … ON CONFLICT DO NOTHING`) so the index and the re-import button work together.
  - Make router writes patch individual keys (`jsonb_set`) or move `lastId` to its own settings key.
  - Fix the tooltip text.
  - Integration test: poll, `clearLastId`, poll again, then the row count is unchanged and a new punch is stored.
- **Verdict:** confirmed from code and reproduced on a throwaway Postgres 16: same index and compare-and-set, two old punches and one new one in one transaction after resetting `lastId` to 0 gave `duplicate key value violates unique constraint "punches_oi_dedup_idx"`, ROLLBACK, `lastId` still 0, the new punch not stored. B13 as originally stated (duplicates appear, LiveResults visit numbers shift, peers lack them) is **refuted**: the index is absent from `schema.prisma` but present in every migrated database. Duplicates would occur only on a database built with `prisma db push`. The race variant needs a save to land within milliseconds of a poll commit; the button is the realistic trigger. (reviewer B13, restated as B13v)

### SYNC-06 Journal replay of `result.applied` maps every status except OK, MP and DNF to Unknown
- **Area / category:** journal ingest; functional (wrong results).
- **Location:** `packages/api/src/routers/events.ts:391-416` (inline ternary 1 to ok, 3 to missing_punch, 4 to dnf, else unknown); `valueToRunnerStatus` is already used for `finish.adjusted` at `:381-383`. Emitters: `packages/api/src/routers/cardReadout.ts:832-851` (`applyResult`) and `:908-934` (`acceptVariant`); station outbox `packages/web/src/context/DeviceManager.tsx:521-527`.
- **What is wrong:** the emitters journal the full numeric status. The same apply path serves the station outbox and node-to-node shipping in both directions, so NoTiming (2), DQ (5), OverMaxTime (6) and OutOfCompetition (15) become Unknown on the receiving node. `acceptVariant` refuses MP, so on that path the bug hits exactly the three non-OK statuses it produces.
- **Scenario:** at the venue a runner exceeds the maximum time. The venue row is right; the cloud row says Unknown with a finish time. Live results on the cloud and the results after checkin show the runner without a result; the cloud LiveResults pusher deletes that runner's remote rows (`packages/api/src/liveresults.ts:402-415`) if the push runs from the cloud.
- **Fix (S):** use `valueToRunnerStatus(status)`. Same defect as RES-07 in area 04; fix once. Add cases for statuses 2, 5, 6 and 15 to `events-push.test.ts`. Already-ingested rows need a repair from the journal payloads.
- **Verdict:** confirmed from code reading; no test ingests `result.applied`. DQ is reached only in the narrow case `computeStatus` returns the current status (finish present, no missing punch, running time of 0 or less). The LiveResults consequence is plausible: it depends on which node pushes (see SYNC-14). The final-results and Eventor-export consequence after checkin follows from the row but was not traced. A related lead (unguarded `toRelative` in the same case) is listed under Leads. (reviewer B5, merged with A4)

### SYNC-07 Checkout deletes the local event without checking for unshipped data, and needs only a signed-in user
- **Area / category:** lease checkout; stability (data loss), authorisation.
- **Location:**
  - `packages/api/src/sync/lease.ts:319`: `tx.event.deleteMany({ where: { nameId } })`, first statement of the import transaction (`:318-368`); assumption comment `:298-300`.
  - Cascades (`schema.prisma`): `journal` 1080, `journal_sync_state` 1130, `event_lease` 1104, `card_readout_backups` 1021, `tracks` 1620, `routes` 1641, `event_permissions` 321. None is in `SNAPSHOT_TABLES` (`sync/lease.ts:157-175`).
  - `packages/api/src/routers/lease.ts:141-216`: no pending-push or local-lease check; auth gate `:144-149` only requires a user.
  - Doc: `docs/system/offline-architecture.md:248` ("checkout requires the venue to be fully shipped-up-to-date").
- **What is wrong:** checkout replaces the local event by cascade delete, and nothing checks that the local copy has no unshipped entries or that the box still holds a local lease. `checkout` is a `publicProcedure` gated only on "signed in", while `checkin` and `forceTakeover` require `event.manage`; with auth off, anyone who can reach the box can call it. Every re-checkout, even fully shipped, also wipes the box's `card_readout_backups` (the raw-readout safety net), `tracks`, `routes` and `event_permissions` without a warning.
- **Scenario (corrected by the verifier):**
  - After a cloud-side force takeover the box is alive but offline and still holds its local lease. A direct `lease.checkout` call on the box (script, stale tab, any signed-in user) succeeds once the cloud lease is free and wipes the box's unshipped finishes and readouts.
  - After a clean checkin the box has no lease, so the UI offers "Check out" and local race writes are accepted. Entries written after checkin and not yet shipped (push stream blocked by a failing entry, or checkout within the 5 s ship interval) are wiped by a re-checkout.
  - Not reachable: pressing the button again while this node still holds the cloud lease (CONFLICT before any delete), or after a failed checkin (barrier throws before release). After a takeover the UI shows "Check in", not "Check out" (`packages/web/src/components/VenueLease.tsx:126,136`).
- **Fix (M):**
  - Before `peer.acquire`, if a local event with that `nameId` exists: run `shipEventOnce`, then refuse with a typed error when unshipped entries remain (the real count, after SYNC-01) or a local active lease exists, unless an explicit `discardLocal: true` is passed; log the discarded count.
  - Keep `card_readout_backups` across the replace (copy out and back in), or warn before discarding them.
  - Require admin, or `event.manage` on the local event when it exists.
  - Integration test: check in, write a race entry on the box with the transport failing, call `lease.checkout`, count `journal` rows.
- **Verdict:** confirmed in part, by code reading. The defect (unconditional delete, no pre-check, weak authorisation) holds. Of the three triggers the reviewer named, only states where the cloud lease is free reach the delete, and the headline takeover scenario is not offered by the UI; the scenario's timing also ignored the automatic drain, which normally ships the backlog within seconds once the link returns. Lowered from critical to high. (reviewer A3)

### SYNC-08 A box with no lease, or a stale one, is still a writer; its backlog overwrites newer cloud data, and it cannot end its lease after a takeover
- **Area / category:** lease enforcement; stability (silent overwrite).
- **Location:**
  - `packages/api/src/sync/lease.ts:67-70,76-87`: no lease, or this node holds it, means writable; `NODE_ROLE` is not consulted.
  - `packages/api/src/routers/lease.ts:260-281`: `forceTakeover` updates only the cloud's own row; the box is never told.
  - `packages/api/src/sync/shipper.ts:268-294`: ships every non-removed event regardless of lease.
  - `packages/api/src/routers/events.ts:229-240,88-150`: unguarded push and ingest loop; `finish.adjusted` (`:368-389`), `result.applied` (`:391-416`) and `applyReferenceUpsert` (`:843-914`) apply unconditionally in arrival order.
  - Box stuck: `routers/lease.ts:249` (cloud release throws "No active lease to release", `sync/lease.ts:121-127`) and `:270-275` ("This node already holds the lease").
  - Docs: `docs/ops/venue-runbook.md:147-148`, `docs/system/offline-architecture.md:260-263` and the comment `routers/lease.ts:257-258` ("conflicts are logged loudly").
- **What is wrong:**
  1. After a force takeover the box keeps its active local lease. When its uplink returns, the shipper pushes hours-old `finish.adjusted`, `result.applied` and full-row upserts, which the cloud applies last-arrival-wins over corrections made after the takeover. Nothing is logged as a conflict; no conflict detection exists. The box cannot clear its stale lease through any API route.
  2. After a normal checkin, stations still pointed at the box keep writing; both nodes now allocate seqs, and a shipped `runner.registered` with a seq the cloud already used fails with P2002 and blocks the stream.
  3. The barrier is not atomic: writes between `shippingStatus` (`:240`) and `releaseLease` (`:250`) are not counted. They are shipped later, not lost.
- **Scenario:** the box's uplink drops at 10:00 while stations keep writing to it. At 12:00 the cloud force-takes over and the organiser corrects three results there. At 12:30 the link returns and the box ships its backlog; the three corrections are overwritten by older venue values, silently.
- **Fix (M):**
  - On a `NODE_ROLE=venue` node, treat "event exists, no active local lease held by me" as not race-writable, with a typed error pointing at the cloud.
  - In the shipper cycle, ask the peer for `lease.status`; if the peer's active holder is not this node, mark the local lease released (forced), stop accepting race writes, and keep shipping the backlog flagged as stale.
  - On the cloud, when a register entry arrives from a node that does not hold the lease, quarantine it or apply only if its HLC is newer than the row's last write, and log one WARN line per entry.
  - Make checkin put the local lease into a "checking-in" state that `assertRaceWritable` rejects, then ship, then release the peer.
  - Integration test: force takeover, edit a result on the cloud, push an older `finish.adjusted`, check the row and the log.
- **Verdict:** confirmed from code reading. Sub-claim 1 is high; 2 is medium (needs stations still on a box the runbook says to shut down); 3 is low. "LAN stations keep writing" needs the box alive but cut off; in the runbook's "box died" case stations were repointed, so the overwrite comes only from the box's unshipped pre-death backlog plus anything written after revival. No test covers a revived box (`lease.test.ts:1255-1274` checks only the flag). (reviewer A6)

### SYNC-09 Backup swallows psql errors and still dumps `event_log`, a table renamed to `journal`
- **Area / category:** backup; functional (data loss at restore time).
- **Location:** `packages/api/src/backup.ts:151` (`"event_log"` in `BACKUP_TABLES`), `:194` (default `SELECT * FROM oxygen.${t}`), `:243-257` (psql args without `-v ON_ERROR_STOP=1`), `:302` (success means exit code 0; stderr ignored); rename in `packages/api/prisma/migrations/20260601130000_journal_rename/migration.sql:11-15`; `docs/ops/backup-restore.md:7` and `:18`.
- **What is wrong:** without `ON_ERROR_STOP`, psql prints the error, continues and exits 0. The `event_log` `\copy` fails on every backup today: its section is an empty separator line and no `-- BACKUP FAILED` trailer is written. More important, any other failing section (a statement timeout, a lock, a permission error, a future rename) is equally silent, and a failure mid-COPY leaves a truncated section. Only connection failures or psql fatal errors produce the trailer.
- **Scenario:** an operator downloads a backup during the race; the `punches` `\copy` hits a statement timeout. The file looks complete, the UI reports success, and the missing table is discovered only when a restore is needed.
- **Fix (S):** fix both parts together. Adding `-v ON_ERROR_STOP=1` alone would make every backup fail at `event_log`, so also rename the entry to `journal` (or drop it and make doc line 7 agree with line 18), and decide whether `event_lease` and `journal_sync_state` belong. Append an explicit `-- BACKUP COMPLETE <n tables>` trailer and document that a file without it is partial. Extend `integration/backup.test.ts` to assert every section is present and that a forced failure yields the FAILED trailer.
- **Verdict:** confirmed and reproduced with psql 16 on a throwaway local server: with the same flags, the missing `oxygen.event_log` printed an error on stderr, left an empty section, dumped the next section normally and exited 0; with `-v ON_ERROR_STOP=1` it stopped with exit 3. The integration test asserts only the absence of `-- BACKUP FAILED` (`backup.test.ts:147`), which this cannot trigger. (reviewer A9)

### SYNC-10 The per-event backup cannot be restored for race data as documented
- **Area / category:** backup and restore; stability, ops.
- **Location:** `packages/api/src/backup.ts:124` ("FK-safe restore order"), `:137-161` (`BACKUP_TABLES`), `:62-68` (header INSERT), `:203-208` (one `\copy` per table, autocommit); `docs/ops/backup-restore.md:56-97`, `:18`, `:97`.
- **What is wrong:**
  - The table order is statically not FK-safe for three pairs, with no concurrency needed: `runners.card_id` references `cards`, `cards.readout_id` references `card_readouts` and `punches.unit_id` references `control_units`, and in each pair the child is dumped (and so restored) first. A plain `\copy` in dump order, the only documented method, fails on any runner with a card, any card with a readout and any punch with a unit. No FK is deferrable.
  - `classes.sheet_template_id` references `map_templates`, which is not dumped; a class with a print template cannot be loaded into a fresh database without blanking that column by hand.
  - The documented "usual path" re-creates the event with a header INSERT of five columns (name_id, name, date, zero_time, annotation). The other ~70 event columns (kiosk key, fees, LiveResults and Eventor config, Sheets webhook and so on) are in the `events` CSV section but no documented step applies them.
  - `card_readout_backups`, `event_permissions`, `map_colour_settings` and `course_presence` are event-scoped, not dumped, and not in the doc's gap list.
  - The dump is 23 separate autocommit snapshots, so concurrent inserts of children after their parent table was copied can also break a restore (a small window).
  - The restore of non-map tables needs hand-rewriting `event_id` with sed and has no test; doc line 97 ("all data intact") is not true for the documented path.
- **Scenario:** after a laptop failure the organiser restores yesterday's backup into a fresh database following the doc. `\copy` into `runners` fails on the first runner with a card; once reordered by hand, the event has no fees, kiosk key or LiveResults config.
- **Fix (M–L):** reorder `BACKUP_TABLES` (`card_readouts`, `cards`, `runners`; `control_units` before `punches`) and fix the comment; wrap the script in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; … COMMIT;`; add `map_templates`, `course_maps`, `graphics`, `card_readout_backups` and `event_permissions`; ship a `restore-event.sql` (temp tables plus `event_id` rewrite, like `restore-map-blobs.sql`) that restores the full event row; add an integration test that dumps a populated event and restores it into a second event.
- **Verdict:** confirmed in substance by code reading, with corrections. The reviewer's FK mechanism ("parent inserted after the parent table was copied") was wrong in direction; the real failure is the static ordering above, which is worse. The `event_seqs` PK-conflict sub-claim is mostly refuted: the trigger does not create counter rows for explicit seqs, so loading `event_seqs` last into a fresh event works. Raised from medium to high. (reviewer A10)

### SYNC-11 Queued writes are not retried after a failed drain
- **Area / category:** station offline queue; stability.
- **Location:** `packages/web/src/hooks/useEventQueue.ts:48-76` (effect deps `[isOnline, pendingCount > 0, competitionId, utils]`; the 2 s poll at `:31-45` never drains), `packages/web/src/lib/offline/sync.ts:63-67` (`catch` then `break`), `packages/web/src/hooks/useOnlineStatus.ts:3-14` (`navigator.onLine` only), enqueue-while-online at `packages/web/src/context/DeviceManager.tsx:408-416`.
- **What is wrong:** auto-drain runs only when `navigator.onLine` flips or the pending count goes from 0 to more than 0. The normal arena failure is "Wi-Fi associated, node unreachable", where `navigator.onLine` stays true. The first queued entry triggers one drain; if it fails, the loop breaks, entries stay `pending` (attempts not incremented) and nothing re-triggers. Whole-request failures (expired IAP session returning HTML, 413, 5xx, a zod rejection of the batch) take the same path and never become `failed`.
- **Scenario:** the venue box reboots (40 s). A readout station queues 6 card reads; if the drain request fails before the box is back, the 6 reads sit behind an amber "6" until someone presses sync, reloads, or leaves and re-enters the competition. New cards meanwhile go online normally.
- **Fix (S–M):** while `pendingCount > 0`, retry with capped exponential backoff (2 s to 30 s), plus on `visibilitychange`, on node-discovery change and after any successful tRPC call. Classify errors in `sync.ts` (network versus server answer) and, after N consecutive non-network failures, show a red state with the message. Add a fetch timeout on `trpcVanillaClient`. Unit-test with a fake client; Playwright test that aborts `events.push` once while online.
- **Verdict:** confirmed from code reading. Not deterministic for a 40 s reboot: with no fetch timeout the single request may hang and succeed when the box returns. The quoted "no silently stuck entries" is not in the doc; what is violated is "drain … on reconnect" (`docs/system/offline-architecture.md:343-346`) for a reconnect the browser does not report. The verifier found a worse variant (whole-batch rejection blocks the queue permanently), listed under Leads. (reviewer B3)

### SYNC-12 Offline registration drops club, payment and person fields; the server silently skips some entries and can put a result on another runner
- **Area / category:** station offline queue, journal ingest; functional (data loss).
- **Location:** `packages/web/src/components/RegistrationDialog.tsx:639-646` (offline payload) versus `:618-632` (online mutation); `packages/web/src/lib/offline/db.ts:50-57`; `packages/api/src/routers/events.ts:445-518` (`runner.registered`; create at `:504-515`), `:488` and `:493` (no else), `:281-311` (`resolveRunner`), guards `:356`, `:398`, `:421`.
- **What is wrong:**
  - The offline payload is `{tempId, name, classId, clubId, cardNo, startTime}`. The server reads `eventorClubId` and `clubName`, never `clubId`, so the runner is created with no club. `fee`, `paid`, `payMode`, `cardFee`, `birthYear`, `sex` and `phone` are not sent at all and cannot be recovered from the journal.
  - An unknown class, or a card already registered, is a silent no-op that is still journaled and acked `synced`; the station shows success.
  - With an unknown class, later `finish.recorded` or `result.applied` for that card resolve no runner and are acked the same way.
  - With the card already registered to someone else, `resolveRunner` finds that other runner, so the offline entrant's finish and result are applied to the other person's row.
- **Scenario:** the laptop loses its network for 20 minutes and 40 direct entries are registered. All 40 appear without club and with fee and paid 0, so the cash report is short and only the printed receipt records the money. One entrant was given a rental card still registered to a runner from another class; that runner's row receives the entrant's finish.
- **Fix (M):** send the same field set as `runner.create` (`clubName`, `eventorClubId: selectedClub?.extId`, `birthYear`, `sex`, `phone`, `fee`, `paid`, `payMode`, `cardFee`) and apply them in `events.ts`; update `RunnerRegisteredPayload`. For station-originated entries, throw (so the entry becomes `failed` with a red badge) when the class is missing, the card belongs to another runner, or a race entry resolves no runner; keep the silent path only for entries echoed from a peer. Extend `e2e/offline.spec.ts:201` to assert club and payment after sync.
- **Verdict:** confirmed from code reading. The verifier corrected the follow-on claim: the silent no-op holds only for the unknown-class case, while the card-collision case is worse (a wrong result on another runner). Some `byCard` skips are harmless (the same registration arriving twice). Triggered only when `navigator.onLine` is false; with the server unreachable but the network up, the dialog shows an error instead. (reviewer B10)

### SYNC-13 The ROC control mapping set in the UI is never used by the puller
- **Area / category:** ROC online-input; functional.
- **Location:** `packages/api/src/routers/onlineInput.ts:202-223` (writes `cfg.mapping` inside `online_input_<eventId>_config`); `packages/api/src/online-input/puller.ts:235,252` (reads `loadMapping(event.nameId)`, key `online_input_mapping_<nameId>`, `online-input/mapping.ts:31-39`); the puller's own loader parses `cfg.mapping` (`puller.ts:48,72`) and never uses it; test `packages/api/src/__tests__/integration/online-input.test.ts:210`.
- **What is wrong:** nothing in production writes `online_input_mapping_<nameId>`; `saveMapping`, `addMapping` and `removeMapping` in `mapping.ts` are called only by the test. A mapping added on the Event page is shown back from the config but has no effect.
- **Scenario:** an organiser maps ROC code 100 to Finish. Radio punches from code 100 are stored and journaled as control 100, not as finish (2), all day.
- **Fix (S):** have the puller use `cfg.mapping` at `puller.ts:235` (the config is already loaded), migrate any values stored under the old key, delete or wire up the unused helpers, and change the integration test to configure through `onlineInput.addMapping`. Update `docs/system/online-input-roc.md`.
- **Verdict:** confirmed by grep and code reading. Not run. The downstream "no radio finish times appear" was not traced past the stored control code; if code 100 exists as a course control, the punch shows as an ordinary split. The integration test passes only because it bypasses the router. (reviewer B6)

### SYNC-14 No node-role gate: a venue box and the cloud both push LiveResults for a checked-out event, and Sheets gets every readout twice
- **Area / category:** background services; stability, docs mismatch.
- **Location:** `packages/api/src/background/supervisor.ts:49-56` (`reconcile` calls `reconcileEnabledPushers` unconditionally), `packages/api/src/index.ts:165-167` (always started), `packages/api/src/leader.ts:54-82` (lease row in the node's own database), `packages/api/src/liveresults.ts:727-784` (no role or event-lease check), `packages/api/src/sync/lease.ts:251-284,320-323` and `sync/settingsRefresh.ts:26-34` (LiveResults config and the Sheets webhook URL travel to the box), Sheets push on ingest `packages/api/src/routers/events.ts:794` (card.read case `:731-796`) and on the venue `routers/cardReadout.ts:745`.
- **What is wrong:** `docs/system/offline-architecture.md:37-40,447-449` says the pushers are "config-flagged so a venue copy never double-runs them". No such flag exists; `NODE_ROLE` is read only by the forwarder and the lease status. After checkout of an event with LiveResults enabled, a venue box with uplink and the cloud both run `syncAll` against the same `tavid` from two databases. The cloud replica lags, so its cycle deletes the remote rows of runners it still sees as Unknown and the venue rewrites them next cycle. For Sheets, the venue pushes on `storeReadout` and the cloud pushes again when the shipped `card.read` is ingested (its dedupe looks at the cloud's own readouts, which do not yet hold it).
- **Scenario:** an event with LiveResults is checked out to the box, which has 4G. Runners who just read out at the arena appear on and vanish from the public results every cycle until the cloud ingests their readouts; the backup sheet has every readout twice.
- **Fix (S–M):** decide the owner in code. Push only where `isRaceWritable(db, eventId)` is true (the leaseholder), or skip pushers and pullers on `nodeRole() === "venue"`, and record the decision in the doc. The same gate is missing for `reconcileEnabledPullers` and `maybeStartStorageGc` (`supervisor.ts:51,55`). For Sheets, skip `pushToGoogleSheet` in ingest when the entry was shipped from a peer node. Test in `background-supervisor.test.ts`.
- **Verdict:** confirmed from code reading that nothing gates it. The general "overwrite and delete each other's rows" is narrowed to the lag effect, which needs no SYNC-06; the part that depends on differing statuses was not judged. Needs the box to have internet; with no uplink only the stale cloud pusher writes. LiveResults is high; the Sheets half alone would be medium. (reviewer B7)

### SYNC-15 LiveResults push deletes and re-inserts every unfinished runner each cycle, one statement at a time, and cycles overlap
- **Area / category:** LiveResults pusher; functional, performance, stability.
- **Location:** `packages/api/src/liveresults.ts:402-404` (every non-removed Unknown runner), `:407-414` (DELETE from `results` and `runners`), `:417-501` (per-runner autocommit upserts; `punch.findMany` per runner at `:475-484` when the course has radio controls), `:350-377` (splitcontrols wipe and per-class inserts), `:580-593` (`setInterval(run)` with no in-flight guard), `:177-188` (`fetchConnectionString` on every call), `:204-205` (pool of 5, no queue limit, no query timeout), `:385` (`removed: false`).
- **What is wrong:**
  - Every cycle removes the remote `runners` row and all `results` rows (start row, radio splits, and a finish row whose status is still Unknown) of every runner whose status is Unknown, then re-inserts them one by one with no transaction. Between delete and re-insert those runners are absent remotely.
  - Cost is 2 to 3 MySQL round trips per runner over the WAN, sequential: 2,000 runners at 30 ms RTT take 2 to 3 minutes against a 30 s default interval.
  - No overlap guard: overlapping runs interleave, so run B's DELETE removes rows run A just re-inserted. A runner late in the list flickers every cycle. `pushNow` adds another concurrent run. A stalled MySQL query holds a pool slot with no application timeout; five stalled runs block all later pushes.
  - Removed runners are never deleted remotely, so a deleted or duplicate entry stays in public live results.
  - `lastPush` is the end time of a cycle that started minutes earlier, and one run's `lastError` is cleared by the next.
- **Scenario:** a 2,000-runner event in the morning, everyone Unknown. Each 30 s tick deletes 2,000 runners and their start rows remotely and takes minutes to put them back, while 4 to 6 further runs are doing the same.
- **Fix (M–L):** add a `busy` flag like the puller's (`online-input/puller.ts:318-331`, S); compute the desired row set and delete only `dbid NOT IN (desired)` for this `tavid`, including removed runners; fetch punches once per event grouped by card; use chunked multi-row `INSERT … ON DUPLICATE KEY UPDATE` inside a MySQL transaction; keep a per-event hash of pushed rows and send only changes; cache the connection string, put `AbortSignal.timeout` on its fetch and set a query timeout. Extend `liveresults-pusher.test.ts` with an overlapping-tick test.
- **Verdict:** confirmed from code reading. Cost corrected from "3+ minutes" to 2 to 3 minutes, and the per-runner Postgres query applies only on courses with radio controls. "Pile up without bound" is conditional (the queue grows only beyond 5 times the interval or on a stalled connection); a hung config fetch holds no pool slot and Node's fetch times out at 300 s. The status panel is less useless than stated. What the remote front end shows during the gap is inferred from the schema; no live MySQL was contacted. (reviewer B8)

### SYNC-16 The service worker answers tRPC queries from a stale cache, so a finished runner's readout can be treated as pre-start
- **Area / category:** service worker; functional.
- **Location:** `packages/web/vite.config.ts:59-79` (same-origin `/trpc/*` GET, `NetworkFirst`, `networkTimeoutSeconds: 3`, 24 h); `packages/web/src/context/DeviceManager.tsx:429-431` (invalidate), `:435-441` (`readout.fetch`), `:448-473` (action decided from the response), `:501` (`applyResult` only for `readout`), `:531-541` (local fallback only in the outer catch); `packages/web/src/lib/trpc.ts:34-63` (cache key includes `?event=`); `packages/web/src/pages/FinishStation.tsx:58` (receipt fetch).
- **What is wrong:** on a link slower than 3 s, or with the node unreachable, the service worker returns the last cached response for that exact URL as an ordinary 200. React Query stores it as fresh data, and nothing marks it as cached. The local fallback is never reached because the fetch "succeeded".
- **Scenario:** a runner checks her card at the readout station before the start (cached answer: found, no result, match score 0). After the race the uplink takes 5 s. `storeReadout` (a POST, not cached) succeeds; the readout GET times out in the service worker and gets the pre-start answer, so the action is `pre-start`, `applyResult` is not called and nothing is queued. The kiosk shows a pre-start screen to a finished runner, and her result stays unapplied until someone re-reads the card on a working link.
- **Fix (M):** stop runtime-caching tRPC for race-critical procedures (the persisted query cache already serves offline reads), or restrict the route to an allow-list of slow-changing queries. At minimum, stamp cached responses (`x-oxygen-sw-cache: 1`) with a Workbox plugin and have the fetch wrapper throw a network-class error for stamped responses of must-be-live procedures (`cardReadout.readout`, `race.lookupByCard`, `runner.findByCard`, `event.counterState`). Add an E2E with a delayed route.
- **Verdict:** confirmed by code reading of the config and consumers; Workbox behaviour taken from its documented NetworkFirst semantics, not run in a browser. Conditional: it needs an earlier read of the same card in the same browser profile within 24 h, the same batch URL (likely, since the fetch after an awaited invalidate goes out alone), and a same-origin tab (tabs rewritten to a venue node bypass this cache). The verifier found the slow-link variant worse than stated: nothing at all is queued and no error is shown. (reviewer B9)

### SYNC-17 Checkout snapshot rows and refreshed settings are written verbatim, so any column the cloud has and the box lacks breaks checkout or the refresh (PR 254 adds two)
- **Area / category:** snapshot import, settings and map refresh; stability (version skew).
- **Location:**
  - Export without `select`: `packages/api/src/sync/lease.ts:251-270`.
  - Import: `importRows` `sync/lease.ts:193-211`, `event.create` `:321-324`, `createMany` `:329-340`; the only filter is `withoutDroppedFields` (`sync/dropped-columns.ts:9-22`).
  - Refresh: `packages/api/src/sync/settingsRefresh.ts:49-55`, `sync/mapRefresh.ts:295-296`; both caught and only warned at `sync/shipper.ts:314-327`.
  - Journal side: `packages/api/src/routers/events.ts:852-902`.
  - PR 254 (`origin/claude/project-thread-avzbks`): `Course.climbSource` and `Course.winnerPaceSPerKm`.
- **What is wrong:** Prisma rejects unknown fields. The cloud is deployed continuously and the box is built once (`docs/ops/venue-runbook.md:30-36`), and AGENTS.md §7 makes additive columns the normal migration. Every new column on `events` or a `SNAPSHOT_TABLES` table breaks checkout from a newer cloud to an older box. PR 254 strips its two new course columns from `course.upserted` because "an older peer's apply knows no such field", but they still travel in `tables.course` with non-null backfilled values. Mid-event, a new `events` column added on the cloud during a lease makes every settings refresh on an older box fail as a whole, so cloud-owned settings silently stop reaching the box; a new column on `course_maps`, `course_objects` or `map_templates` does the same to the map refresh.
- **Scenario:** a box built before PR 254 tries to check out an event from a cloud running PR 254. Checkout fails with `PrismaClientValidationError: Unknown argument climbSource`. The failure is clean (one transaction, peer lease rolled back), but the organiser cannot run the event on the box until it is rebuilt.
- **Fix (M):** one helper that filters keys to the importer's own model scalar fields (Prisma DMMF), logging dropped names once, used in `importRows`, `importEventSnapshot`, `refreshCloudOwnedSettings`, `applyMapRows` and `applyReferenceUpsert`; it replaces the hand-kept dropped list. Add a build or schema id to `lease.exportSnapshot` and `lease.status`, and warn "box is older than the cloud" before checkout. Test: a snapshot with an unknown column on `course` and on `event` imports.
- **Verdict:** confirmed by code reading; the Prisma rejection was not executed (no `node_modules`), but the repo states the failure mode itself (`dropped-columns.ts:4-6`, `docs/map-symbols.md:2249-2251`). The journal-direction sub-claim is not caused by PR 254 (it strips both fields) and is medium in general: a future unstripped column would block an older receiver's stream until it is upgraded, more likely the box pulling from a newer cloud. The verifier added the mid-event refresh failure. The new `leg_routes` table is harmless to an old importer. (reviewer A8)

---

## Medium

### SYNC-18 Checkout and checkin are not restart-safe or network-safe
- **Area / category:** lease; stability.
- **Location:** `packages/api/src/routers/lease.ts:154` (`peer.acquire`, outside the `try`), `:156-168` (snapshot and blob fetches), `:169` (import commits), `:172-189`, `:210-215` (rollback `peer.release(...).catch(() => {})`), `:249-250` (peer then local release); `packages/api/src/sync/lease.ts:91-114` (acquire not idempotent), `:116-127` (release throws when nothing is active).
- **Scenario:**
  - Checkout: `peer.acquire` succeeds, then the link drops during the blob downloads. The rollback release goes over the same dead link and its failure is swallowed without a log. The cloud now rejects race writes, the box has no event, and a retry fails with CONFLICT; only a cloud-side force takeover clears it.
  - A throw between the import commit and `acquireLease` leaves both nodes writable with no lease (a retry recovers); a process death there leaves the cloud locked and the box writable.
  - Checkin: `peer.release` succeeds and the response is lost. The cloud is writable, the box still holds its lease, and every checkin retry fails at "No active lease to release". Two nodes write and allocate seqs for one event.
- **Fix (M):** make `lease.acquire` idempotent for the same holder and `lease.release` idempotent when the last released lease was this holder's; in checkin treat "peer has no active lease for us" as already released; log rollback failures at ERROR with the remedy; persist a "checkout in progress" marker so a restart resumes or rolls back. Tests that inject a throw after each step.
- **Verdict:** confirmed from code reading. Overstated: the cloud page shows the "checked out to" state with a Force takeover button and the error names the holder, so the way out is visible, though nothing says the state came from a failed checkout. "Fails forever" has an unadvertised exit (an API-only re-checkout), which wipes unshipped local entries (SYNC-07). Lowered from high to medium: no journal data is lost in the three scenarios themselves. (reviewer A7)

### SYNC-19 The station's query cache is not scoped by competition, so offline readout uses another competition's runners and courses
- **Area / category:** station offline queue; functional, cross-competition.
- **Location:** `packages/web/src/lib/offline/local-readout.ts:320-331` (`findCachedQuery` returns the first match, ignoring input), used at `:62-63`, `:167-168`, `:299`; `packages/web/src/main.tsx:19-27,76-87` (one global cache under one key, `lib/offline/persister.ts:4`); `packages/web/src/pages/CompetitionShell.tsx:145-153,229-256` (offline switch keeps the old cache and sets `ready`); `packages/api/src/routers/events.ts:282-311` (`resolveRunner` seq fallback).
- **Scenario:** stage 1 and stage 2 are separate competitions with the same runners. The laptop synced stage 1 on Saturday and opens `/stage2` with no network on Sunday. The shell shows stage 1's name under stage 2's URL; a card read is matched against stage 1's runners and course, so the screen, kiosk and receipt show a stage-1-derived result (MP when the courses overlap by at least 20%, otherwise "pre-start" with the stage 1 runner's name).
- **What is not happening today:** the server-side corruption step (the stage-1-derived `result.applied` queued for stage 2 and applied) does not occur, only because that emit is dead code (SYNC-03). Fixing SYNC-03 makes it real, so fix both together. `finish.recorded` carries no status and resolves by card within stage 2, so it lands on the right person unless the seq fallback hits.
- **Fix (M):** scope the cache by competition: store the `nameId` with the persisted cache (a marker query or `buster: nameId`) and `queryClient.clear()` on mount when it differs, or keep one persisted cache per `nameId`. In `local-readout.ts` look up exact keys (`runner.list` with `undefined` input) instead of the first match. Tests with two cached `runner.list` entries and an offline competition switch.
- **Verdict:** confirmed in part by code reading. Root cause and wrong local display confirmed; the queued-and-applied corruption refuted at main as described. "Also affects online use" is overstated: the lookups run only in the offline or failed-fetch path, where an input-filtered `runner.list` cached first can turn a registered runner into "register". Lowered from critical to medium, latent critical. A related projection lead is listed under Leads. (reviewer B2)

### SYNC-20 Ingest applies and journals outside a transaction, and continues past a failed entry
- **Area / category:** journal ingest; stability.
- **Location:** `packages/api/src/routers/events.ts:96-148` (find `:99`, apply `:108`, journal insert `:122`, follow-up `:137`, catch-and-continue `:140-148`); multi-statement applies `:690-728`, `:875-893`, `:898-913`; FK `schema.prisma:553`.
- **Scenario:**
  - The ingest loop does not stop at a failed entry, so if a `control.upserted` fails, the later `course.upserted` in the same batch is still applied: `courseControl.deleteMany` commits and `createMany` fails on the FK, leaving the course with zero controls. If the control entry fails permanently, the course stays empty. Entries after a failed one are applied and journaled out of order while the shipper's watermark stops at the failure.
  - Two concurrent ingests of one id (two tabs of one station, or `lease.checkin` calling `shipEventOnce` while the background tick is mid-cycle) both apply; the second journal insert throws P2002 and the entry is reported `failed` although it was applied. A non-idempotent apply (`runner.registered` without a row id) can run twice.
  - A crash between apply and journal insert leaves an unjournaled row; the senders' normal retry repairs it.
- **Fix (M):** wrap each entry's find, apply, journal insert and follow-up in one `db.$transaction`, pass `tx` into `applyEvent`, treat P2002 on the journal id as `synced`, and stop the batch at the first failure so later entries are not applied out of order. Keep the Sheets push outside.
- **Verdict:** confirmed from code reading. The spec citation is overstated: `docs/system/offline-architecture.md:203-206` states the same-transaction rule for `emitAndApply`, not for ingest. The reviewer's "station retry plus shipper echo" trigger is doubtful; the triggers above exist. The "live results against an empty course" effect was not traced. (reviewer A12)

### SYNC-21 Node-to-node calls and the venue forwarder have no timeout
- **Area / category:** journal shipping, forwarder; stability.
- **Location:** `packages/api/src/sync/shipper.ts:86-98` and `packages/api/src/sync/lease.ts:428-439` (`httpLink` without `fetch` or signal); `shipper.ts:357-372` (`busy`), `:277-293` (sequential loop), `:303-332` (settings refresh in the same window); `packages/api/src/sync/venueForwarder.ts:164-183`; `packages/api/src/routers/lease.ts:234-239,249`.
- **Scenario:** the arena's 4G link accepts the TCP connection and then black-holes. Each request waits for Node's fetch defaults (about 300 s for headers), every event's request hangs in turn, all ticks are skipped meanwhile, a forwarded layout save hangs instead of answering the typed CLOUD_UNREACHABLE, and a checkin click hangs.
- **Fix (S):** pass `fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })` to both `httpLink`s (longer for `exportSnapshot` and `exportBlob`), and `signal: AbortSignal.timeout(20_000)` in the forwarder, matching the bound `refreshAfterForward` already has (`venueForwarder.ts:111-116`).
- **Verdict:** confirmed from code reading (no timeout anywhere in `sync/`). Undici defaults are from documentation, not measured. "One bad event delays every other" is restated: a bad link stalls every event in turn. No data is lost; shipping is delayed. (reviewer A13)

### SYNC-22 `exportEventSnapshot` reads its tables without a transaction
- **Area / category:** lease checkout; stability.
- **Location:** `packages/api/src/sync/lease.ts:247-294` (sequential reads, journal head read last at `:277-281`) versus `sync/mapRefresh.ts:226-231` (RepeatableRead); `packages/api/src/trpc.ts:176-180` (`assertRaceWritable` runs before the mutation's transaction); `journalEmit.ts:59`.
- **Scenario:** while a checkout is in progress with the event live, a ROC punch or an `events.push` entry (both allowed on the cloud during a lease) commits after the `punch` table was read but before the journal head read. The snapshot lacks the row, the venue's pull cursor starts past its entry, and the venue never gets it. A slow guarded mutation (bulk update, import, draw) that passed the lease check before `lease.acquire` can do the same to a runner row.
- **Fix (S):** run the export in one RepeatableRead transaction with the head read inside, as `exportMapRows` does; re-check the lease inside the write transaction (or take a short per-event advisory lock in `acquireLease` and `raceProcedure`). The HLC-before-commit gap is SYNC-01's.
- **Verdict:** confirmed from code reading; not reproduced. The window is narrow for guarded mutations (they must span the acquire and the round trip) and wider for the unguarded appends. (reviewer A15)

### SYNC-23 Under `AUTH_MODE=proxy`, push and the forwarder are not authenticated the way the docs imply
- **Area / category:** journal shipping, forwarder; security, deployment.
- **Location:** `packages/api/src/routers/events.ts:229` (`events.push` checks the user, not the sync secret; `trpc.ts:116-124,190-205`); `packages/api/src/auth.ts:132-141`; `scripts/gcp/deploy.sh:175`; `packages/api/src/sync/venueForwarder.ts:164-194`; `docker-compose.venue.yml:47-59`; `packages/api/src/trpc.ts:198`; `packages/api/src/sync/shipper.ts:289`.
- **What is wrong:**
  1. Push is authenticated by proxy identity, not by the secret. On the documented deploy it works only because `AUTH_AUTO_PROVISION=member` silently turns the venue service account into a member. On an invite-only cloud, or after someone deactivates the odd-looking service-account user, every push is UNAUTHORIZED, pulls stop too (push runs first and aborts the cycle), and the log reads "cycle failed (peer unreachable?): Not authenticated".
  2. The forwarder sends no IAP bearer and no secret, so behind IAP every forwarded cloud-owned mutation gets IAP's response (likely a redirect followed to a 200 HTML page, or a non-tRPC 401) relayed instead of the typed error. Even with a bearer, IAP would run the mutation as the service account, which holds no event role.
  3. The forwarder relays the client-supplied identity header; this adds nothing a LAN client cannot already send to the cloud.
  4. The secret comparison is `!==`, not `timingSafeEqual`.
  - The compose file lacks `SYNC_GOOGLE_AUDIENCE` and `GOOGLE_APPLICATION_CREDENTIALS` pass-through, although the deploy doc tells the operator to add them.
- **Fix (M):** accept the sync secret on `events.push` as an alternative to a user (see SYNC-04's split); build the forwarder's headers through `makeSyncHeaders` and decide which identity forwarded mutations run as; answer the typed 412 on a non-JSON upstream reply; add the two env vars to `docker-compose.venue.yml`; document the service-account identity; use `timingSafeEqual`.
- **Verdict:** confirmed in part by code reading. Sub-claim 1's headline ("every push is UNAUTHORIZED" on the documented deploy) is overstated and narrowed to invite-only clouds; the more serious side of the same fact (any IAP-admitted account can push) is folded into SYNC-04. IAP behaviour was inferred, not exercised. (reviewer A14)

### SYNC-24 Queue writes are fire-and-forget, so a failed storage write loses the event while the UI shows success
- **Area / category:** station offline queue; stability.
- **Location:** `packages/web/src/context/DeviceManager.tsx:411,421,521,573` and `packages/web/src/pages/FinishStation.tsx:161` (`emitEvent` not awaited, no `.catch`); `packages/web/src/lib/offline/events.ts:22-33,37,42,72-80` (unguarded `localStorage` access before the Dexie add); `packages/web/src/lib/offline/db.ts:171-227` (no open-failure handling).
- **Scenario:** IndexedDB quota is reached (map documents, the runner database and the query cache share it), or site storage is blocked. `emitEvent` rejects unhandled; FinishStation still shows "finished <name>" and prints the receipt. For a manual finish or `result.applied` there is no second copy. A Dexie open failure stays sticky for the session.
- **Fix (S–M):** await `emitEvent` at all five call sites and show a blocking error on rejection; wrap the `localStorage` calls (fall back to an in-memory clock and station id); add Dexie `blocked` and `versionchange` handlers; call `navigator.storage.persist()` on station pages.
- **Verdict:** confirmed from code reading that rejections are unhandled. Triggers narrowed: current browsers allow storage in private windows, and Dexie's default `versionchange` handler probably closes the old connection, so the "old tab blocks the upgrade" trigger is plausible at best (library not readable locally). (reviewer B11)

### SYNC-25 Paused React Query mutations are persisted but cannot resume after a reload, and their variables (including secrets) are written to IndexedDB
- **Area / category:** station offline; stability, security.
- **Location:** `packages/web/src/main.tsx:19-27` (no `mutations.networkMode`), `:76-87` (`shouldDehydrateMutation: () => true`, comment at `:83`); header at request time `main.tsx:51-64`; examples `packages/web/src/pages/CardReadout.tsx:173-179` and `pages/CardsPage.tsx:381,649` (`runner.setCardReturned`), `components/EventorKeysPanel.tsx:60`, `components/CourseImportDialog.tsx:88`.
- **Scenario:** an organiser marks a rental card returned while the laptop is offline. The mutation pauses. After a reload it is restored without a `mutationFn` and is dead, with no UI. Without a reload it resumes on reconnect with the header of whatever competition is open then. The Eventor API key typed into the keys panel is persisted in the mutation's variables.
- **Fix (S–M):** stop dehydrating mutations and set `mutations: { networkMode: "always" }` so offline calls fail fast and the explicit outbox is the only queue; or register `setMutationDefaults` for chosen procedures and bind the competition into the variables. Fix the comment.
- **Verdict:** confirmed for the main sub-claims by code reading; the dead-after-reload step is TanStack v5 and tRPC v11 behaviour from knowledge, not read locally. The "start-station actions" example is dropped (StartStation has no mutation). Station hot paths (finish, readout, registration) are guarded. The secrets part alone is low (same-origin storage, 24 h). (reviewer B12)

### SYNC-26 One out-of-range ROC row blocks all radio punches, and a non-ROC body is reported as a healthy poll
- **Area / category:** ROC online-input; stability, logging.
- **Location:** `packages/api/src/online-input/roc.ts:40-77` (checks only `> 0` at `:62-67`); `puller.ts:113,115` (`::int` casts), `:247-283` (one transaction), `:143-144` (only non-2xx rejected), `:214-220` (unreachable parse-error branch), `:228-232` (zero rows clears the error).
- **Scenario:** a corrupt line yields a punch id above 2,147,483,647; the watermark cast fails, the transaction rolls back on every tick, and every later punch is blocked; the UI can only reset `lastId` to 0, which does not skip the row. Separately, a captive-portal page returned as 200 parses to zero rows and is recorded as a successful poll, so the operator sees a green "last polled" and no punches.
- **Fix (S):** validate ranges in `parseResponse` (int4 for card and id, or switch the cast to `bigint`; code below 1024), skip bad rows and advance past them, and count skipped rows; when the body is non-empty and no line parses, record "Unexpected response" with the first 80 characters. Unit tests in `online-input-roc.test.ts`.
- **Verdict:** confirmed from code reading; the int4 failure was not executed. The stuck state is not silent (`last_error` is rewritten each tick). Whether real ROC ids approach int4 is unknown; a corrupt line is the likelier source. No punches are lost in the captive-portal case. (reviewer B14)

### SYNC-27 Clock skew is checked only after a successful drain, and online manual finishes are never checked
- **Area / category:** station offline queue; functional.
- **Location:** `packages/web/src/lib/offline/sync.ts:40-43` (only caller of `recordClockSkew`), `packages/web/src/lib/offline/clock-skew.ts:15,23-28` (in memory only), `packages/web/src/pages/FinishStation.tsx:153-158` (offline finish from `new Date()`), `:221-227` (online manual finish from `new Date()`), `packages/api/src/routers/race.ts` (`recordFinish` uses the input time).
- **Scenario:** a finish laptop's clock is 2 minutes slow. Every manually keyed finish, online or offline, is recorded 2 minutes early. Online, no push carries events, so no skew check ever runs and no banner appears; offline, the banner appears only after the first batch has been applied.
- **Fix (S):** feed the `race.serverTime` the station pages already poll (`FinishStation.tsx:36-38`, `StartStation.tsx:17-19`) into `recordClockSkew` on mount and periodically; persist the last known skew; block or correct manual finishes above the threshold.
- **Verdict:** confirmed from code reading; the verifier found the online manual finish also unchecked, which widens the claim. Finish times read from SI cards do not use the laptop clock. (reviewer B18)

### SYNC-28 The query-cache persister writes the whole cache, including the runner database, on every query change
- **Area / category:** station offline; performance.
- **Location:** `packages/web/src/lib/offline/persister.ts:11-23` (one idb-keyval entry, no throttle), `packages/web/src/main.tsx:76-87` (no `shouldDehydrateQuery`), `packages/web/src/hooks/useStationSync.ts:36-39,69-73` (`eventor.runnerDbDump`, "~9 MB", `gcTime: Infinity`), `packages/web/src/components/SyncStatusIndicator.tsx:187-197,442` (stringifies every query on each 2 s render).
- **Scenario:** on a start station polling `race.serverTime` every second, the library saves the full dehydrated cache (about 10 MB with a populated runner directory) at least twice a second, all day, with overlapping writes and the structured clone on the main thread. When a write fails on quota, the production build swallows the error and the offline cache silently stops updating.
- **Fix (M):** exclude `eventor.runnerDbDump` from dehydration and store it once in its own Dexie table; throttle the persister; surface persist errors in the sync panel; compute the cache size once when the panel opens.
- **Verdict:** confirmed from code reading and from the published source of the locked `@tanstack/query-persist-client-core@5.107.1` (no throttle on this path). Not profiled. The library does catch save errors but logs only outside production. The 10 MB figure depends on the runner directory being populated. (reviewer B17)

### SYNC-29 The Google Sheets backup silently loses rows, and registrations are never sent
- **Area / category:** Google Sheets backup; stability, logging.
- **Location:** `packages/api/src/sheetsBackup.ts:73-89` (one `fetch`, response discarded, warning without event or card), `:46-66` (a DB error caches an empty URL for 60 s), `:105-111` (`pushRegistrationToSheet`, no caller); call sites `routers/cardReadout.ts:745,1646`, `routers/events.ts:794`; UI `packages/web/src/pages/EventPage.tsx:1630-1690`.
- **Scenario:** the venue box has no uplink for an hour, or the Apps Script returns an error page; every readout row in that time is missing from the sheet, nothing is shown in the UI, and the log line cannot identify the rows. The "Registrations" sheet only ever receives the test row.
- **Fix (M):** persist pending rows in a small outbox table and drain from the leader with retry; check `res.ok`; add `AbortSignal.timeout(10_000)`; store a last error and pending count and show them by the webhook setting; wire `pushRegistrationToSheet` into the registration paths or remove it. Extend `sheets-backup.test.ts`.
- **Verdict:** confirmed from code reading. The verifier refuted "registration rows are lost on network problems" (they are never sent at all, which is worse) and added the 60 s silent-skip path. Kept at medium: the primary record is Postgres. (reviewer B15)

### SYNC-30 The leader's acquire hook runs inside the renewal tick, so a slow first reconcile stops renewals; in-flight work is not cancelled on loss
- **Area / category:** leader lease; stability.
- **Location:** `packages/api/src/leader.ts:182-209` (`ticking` held across `await this.notify(this.onAcquire)` at `:200`), `packages/api/src/background/supervisor.ts:116-122,132-142`, `:124-130` (`stopAll` only clears timers); `liveresults.ts:595-606`, `sync/shipper.ts:379-384`.
- **Scenario:** on a two-instance cloud with a stalled database or exhausted pool, the first reconcile takes over 30 s; renewals are skipped, the lease lapses, the other instance takes it, and this one keeps its pushers running until the hook returns plus up to 10 s. On any handover, a running LiveResults `syncAll` or shipper cycle runs to completion on the old leader.
- **Fix (S–M):** do not await the hook inside `tick` (or renew on an independent timer); pass an abort signal or generation counter into `syncAll` and the shipper cycle, as the storage GC already does. Test with a slow `onAcquire` in `leader-lease.test.ts`.
- **Verdict:** confirmed as a mechanism by code reading. The trigger is overstated: the first reconcile is about six small queries and does not scale with events, so it needs a stalled database. The overlap lasts from takeover until the hook returns plus up to 10 s, not "up to a renew interval". The ROC puller is protected by its compare-and-set; LiveResults and the shipper are not. Cloud Run is capped at two instances. (reviewer B16)

### SYNC-31 A reconcile in flight when leadership is lost restarts the jobs on a non-leader
- **Area / category:** background supervisor; stability.
- **Location:** `packages/api/src/background/supervisor.ts:132-142` (`reconcileOnce` never checks leadership), `:49-56`, `:124-130`, `:111-114`; `packages/api/src/leader.ts:201-204` (`onLose` fires once), `:167-180` (`stop()` does not wait for an in-flight tick).
- **Scenario:** on a multi-instance cloud the leader's renew fails while a reconcile is awaiting its queries; `onLoseLeadership` stops everything, then the reconcile resumes and starts pullers and pushers again. Another instance takes the lease, and both now poll ROC and push LiveResults until this instance wins and loses again. Separately, a tick in flight during `stop()` can re-insert the lease row after the release, so the replacement waits out the 30 s TTL.
- **Fix (S):** check `this.lease.isLeader()` after each await in `reconcileOnce` and `reconcile`, and call `stopAll()` if not; make `LeaderLease.stop()` wait for the in-flight tick or set a flag the tick checks before `onAcquire`. Unit test with a fake store and a deferred job.
- **Verdict:** confirmed from code reading; not reproduced. Narrowed: two pollers do not duplicate punches (the watermark compare-and-set makes the loser insert nothing), so the harm is duplicate polling and LiveResults uploads; the shipper part applies only on a single-instance venue box; a database stall restarts the jobs only if the in-flight queries then succeed. `stop()` is called only at shutdown. Line references corrected (off by one). (reviewer A16)

### SYNC-32 A station switching between venue and cloud with entries queued writes race data to the cloud during a lease
- **Area / category:** station offline queue, node discovery; stability.
- **Location:** `packages/web/src/lib/offline/sync.ts:35` and `packages/web/src/lib/node-discovery.ts:218-227` (drain goes to whatever node is active); `packages/api/src/routers/events.ts:229` (no lease guard, deliberate per `trpc.ts:169-175`); `packages/web/src/hooks/useEventQueue.ts:48-76` (no drain on node change); `node-discovery.ts:30-31,113-148,166-181` (one failed 3 s probe flips the node).
- **Scenario:** the event is leased to the box; one slow `/health` probe (or the box dying) moves a station to the cloud. Its queued `result.applied`, `finish.recorded` and `runner.registered` are applied at the cloud and acked, contradicting `docs/system/offline-architecture.md:85-90,326-335,343-345`.
- **Fix (M):** have the cloud answer station-originated register entries with the typed "checked out to venue" error when it does not hold the lease (keep peer-shipped entries, identified by the secret); keep entries pending while the active node differs from the one they were queued for; require two failed probes before leaving a venue node; document the rule in "Station resilience".
- **Verdict:** confirmed for the mechanism by code reading; the consequence is plausible only. Entry-id idempotency and `tempId` dedupe make duplicate rows unlikely; what follows from the code is that the two nodes apply entries in different orders and that the cloud mints a seq while not the allocator, which may collide on the `(event_id, seq)` unique index and block the stream (not traced). (reviewer B20)

### SYNC-33 PR 254 `legRoute` in the snapshot: the wiring is correct, but routes drawn on the box never reach the cloud
- **Area / category:** snapshot (PR 254); functional.
- **Location (branch `origin/claude/project-thread-avzbks`):** `packages/api/src/sync/lease.ts:169-170`; `packages/api/src/routers/legRoute.ts:92,123,137` (`coursesEditRaceProcedure`); `packages/shared/src/cloud-ownership.ts` (no `legRoute.` prefix); `packages/api/src/sync/mapRefresh.ts` (no `leg_routes`); `docs/course-elevation.md:1450-1451`.
- **What is wrong:** the snapshot export and import of `legRoute` are correct (FK order, UUID key, no seq, older exporters and importers tolerate the key). But route writes are lease-guarded and not journaled, so during a lease they run only on the box and never reach the cloud; the next checkout wipes the box's copy. In the other direction, automatic routes the cloud writes after checkout are not mirrored; the box computes its own on its next course edit, but a forwarded object edit does not trigger that, and journal ingestion does not trigger a refresh on the cloud either.
- **Scenario:** a course setter draws route choices on the box during a lease. After checkin the cloud has none of them; the next checkout replaces the box's copy with the cloud's.
- **Fix (M):** a design decision, not a drop-in. Making `legRoute.` cloud-owned and mirroring `leg_routes` in the map refresh does not work as is: a forwarded `legRoute.save` resolves controls by public id on the cloud, and a control created on the box moments earlier has not shipped yet; and the box's own auto-route worker writes `leg_routes` locally, which a mirror refresh would fight. Either journal the routes, or forward them and suppress the worker on a venue node. Enqueue an auto-route refresh after `applyMapRows` and after ingesting course entries.
- **Verdict:** confirmed by reading the diff. "Thrown away at checkin" is reworded: checkin deletes nothing; the box's routes simply never reach the cloud and the next checkout wipes them. The PR's own "Pending in this chapter" lists the limit. The two new course columns are SYNC-17's. (reviewer A18)

### SYNC-34 Test gaps, and a test that hides SYNC-13
- **Area / category:** tests.
- **Location:** `packages/web/src/lib/offline/sync.ts`, `lib/offline/events.ts`, `hooks/useEventQueue.ts` (no unit tests); `DeviceManager.tsx:313,408-425`; `packages/api/src/__tests__/integration/events-push.test.ts:57-204`; `packages/api/src/__tests__/integration/online-input.test.ts:210`; `e2e/offline.spec.ts:201,251`.
- **What is wrong:** no unit tests for the outbox drain, the batch loop, partial acks, request-level errors, the competition filter or re-drain after failure (E2E covers only the happy path and one rejection); none for `addRecentCard`'s queue branches (SYNC-03), `result.applied` ingestion (SYNC-06), `runner.registered` field parity (SYNC-12), a venue-role node not starting pushers (SYNC-14, which has no gate to test), or LiveResults tick overlap (SYNC-15). The online-input test seeds the mapping with `saveMapping()`, which production never calls, so it passes while the UI path is broken. `e2e/offline.spec.ts` checks only that a runner with that name exists after sync.
- **Fix (M):** add the tests named in each finding; configure the online-input test through the router; assert club and payment in the offline E2E.
- **Verdict:** confirmed by grep over test files. (reviewer B19)

---

## Low

### SYNC-35 Control units written at the venue are not returned at checkin
- **Location:** `packages/api/src/routers/control.ts:1481-1482,1498-1502,1623` (direct `control_units` writes, no journal); `packages/shared/src/journal.ts:29-45`; `packages/shared/src/cloud-ownership.ts:16-43`; `packages/api/src/routers/lease.ts:224-250`.
- **What is wrong:** station programming at the venue (serial links, battery, firmware, memory-cleared time, SRR config) writes `control_units` locally without a journal entry, and checkin returns only the journal, so the cloud keeps the pre-checkout rows. This contradicts "non-journaled data is never written on the venue" in `docs/system/offline-architecture.md`.
- **Fix (S–M):** journal control-unit changes, or route them through the cloud as cloud-owned; add a journal-completeness test per `SNAPSHOT_TABLES` table ("written at venue means journaled or forwarded"). Separately, reword the boundary rule that names zero time as journaled although no entry type exists.
- **Verdict:** confirmed for control units by code reading. The zero time/date and teams sub-claims are **refuted** as live bugs: no mutation writes `zero_time` or `date` after creation, and the API has no write to `team` at all; they remain a latent doc and design gap. Whether lost `control_units` rows affect `punches.unit_id` was not settled. A stronger variant (event-row settings mutations) is listed under Leads. (reviewer A17)

### SYNC-36 The backup stream has no backpressure and does not stop psql when the client goes away
- **Location:** `packages/api/src/backup.ts:292-311` (`dump.stdout.on("data", (chunk) => out.write(chunk))` at `:296`, no close handler, no `kill`).
- **Scenario:** a large OCAD source dumps as hex (twice its size); a stalled or slow download makes the API hold the whole dump in memory, and repeated clicks start parallel dumps. On abort, psql still runs to completion and the buffered part stays until it exits.
- **Fix (S):** `pipeline(dump.stdout, out, { end: false })` with the trailer written in the exit handler, and `out.on("close", () => dump.child.kill())`.
- **Verdict:** confirmed and reproduced in Node 22: a 200 MB child with no reader left `writableLength` at 200,000,000; destroying the stream mid-way did not stop the child. Narrowed: the memory is external buffer memory (RSS), not the V8 heap; it stops growing after an abort; psql finishes in seconds. Lowered from medium to low. (reviewer A11)

### SYNC-37 Control and course version tokens are rounded through the checkout snapshot
- **Location:** `packages/api/src/sync/lease.ts:180,204-209,234-236` (`TOKEN_TABLES` lacks `control` and `course`); `packages/api/src/bigint-json.ts:22-27`; `packages/api/src/referenceJournal.ts:132-161`; `packages/api/src/routers/control.ts:999-1004`.
- **Scenario:** a Field-mode outbox entry queued with a token loaded from the cloud is replayed against the box, which stores the token rounded to a multiple of 16; the box answers CONFLICT. A field move re-sends itself automatically; a description, code or course-structure write needs one "refresh, redo".
- **Fix (S):** add `control` and `course` to `TOKEN_TABLES`.
- **Verdict:** confirmed by code reading and a `node -e` rounding check. `basePayload` finding no base entry is because pre-checkout history is not on the box, not because of rounding. No data is lost. (reviewer A19)

### SYNC-38 Logging gaps make sync failures hard to diagnose at an arena
- **Location:** `packages/api/src/routers/lease.ts:210-215` (rollback failure swallowed; no lease-transition lines); `packages/api/src/sync/shipper.ts:277-292` (every error labelled "peer unreachable?", no periodic progress line); `packages/api/src/sync/venueForwarder.ts:195-197` (bare `catch`); `packages/api/src/routers/events.ts:103-106,356,377,398` (silent no-ops still journaled and acked).
- **Fix (S):** log lease transitions on both nodes with counts; include the tRPC code or HTTP status in shipper warnings; log one WARN when an ingested entry matches no runner; log the forwarder's failure reason.
- **Verdict:** confirmed by code reading. Overstated in part: Fastify logs each request with its status, and the shipper line does include `err.message`; the misleading label and the missing status code are the problem. (reviewer A20)

### SYNC-39 No handler for unhandled rejections; shutdown has no deadline and no re-entry guard
- **Location:** `packages/api/src/index.ts:171-187`.
- **What is wrong:** on Node 24 a stray unhandled rejection terminates the API (Docker restarts it, and SYNC-01's clock restarts with it). `shutdown` has no deadline and runs twice on a second signal; an in-flight shipper cycle is not awaited before `disconnectAll()`.
- **Fix (S):** an `unhandledRejection` handler that logs with stack; guard `shutdown` with a flag and a 10 s `setTimeout(...).unref()` exit.
- **Verdict:** confirmed from code reading. The fire-and-forget paths read are all guarded, so the crash is a latent risk; the double signal costs only duplicate log lines; the interrupted shipper cycle costs a log line, not data. (reviewer A21)

### SYNC-40 Docs that no longer match the code (server side)
- **Location and items:**
  - `docs/system/offline-architecture.md:275-276`: counters "travel back with the barrier"; not implemented (SYNC-02).
  - `offline-architecture.md:248`: checkout "requires the venue to be fully shipped-up-to-date"; not checked (SYNC-07).
  - `offline-architecture.md:203-206`: the same-transaction rule is about `emitAndApply` and is not false as written, but its conclusion ("journal completeness is structural") does not hold for ingest (SYNC-20).
  - `docs/ops/venue-runbook.md:115-120` says the box's copy "does not follow them yet", contradicting `:71-75` and the code.
  - `venue-runbook.md:147-148` and `offline-architecture.md:260-263`: "conflicts are logged loudly"; no such code (SYNC-08).
  - `docs/ops/backup-restore.md:122` says the endpoint is open to anyone; `backup.ts:315-339` requires `event.manage`. Line 7's `event_log` matches the code list, so it is a code bug mirrored in the doc (SYNC-09), not a doc mismatch.
- **Fix (S):** update each passage with the corresponding fix.
- **Verdict:** confirmed for five items, partly for one. The item about `packages/api/src/sync/nodeIdentity.ts:11-12` is **refuted** and dropped: the comment already says a later step keys off the role. (reviewer A22)

### SYNC-41 Server-side test gaps
- **Location:** `packages/api/src/__tests__/integration/` (`journal-shipping.test.ts`, `lease.test.ts`, `events-push.test.ts`, `backup.test.ts`), `__tests__/background-supervisor.test.ts`, `e2e/lease.spec.ts`.
- **What is wrong:** no test for a late-HLC entry (SYNC-01), a post-checkin create on the cloud (SYNC-02), re-checkout with pending entries (SYNC-07), `result.applied` with status 2/6/15 (SYNC-06), a push to event A touching event B (SYNC-04), every backup section present plus a forced psql failure (SYNC-09), or leadership lost mid-reconcile (SYNC-31). Checkout failure injection is partly covered (blob and graphic hash failures with rollback, the checkin barrier); failures after the import or between the two releases are not. Unknown-column snapshots are partly covered (known dropped columns only). The HTTP peer clients `httpLeasePeer` and `httpPeerTransport` are never exercised; journal pages are not JSON round-tripped; GET-size limits of `exportSnapshot` are untested. `e2e/lease.spec.ts` is single-node.
- **Fix (M):** add each small two-node test, and one test that boots two Fastify instances on the two test databases and runs checkout, write, ship and checkin over real HTTP (the `provisionNodeB` database and the stub-cloud pattern in `lease.test.ts` make it small).
- **Verdict:** confirmed by test titles and grep. Corrections applied: `e2e/lease.spec.ts` takes the lease through the real endpoint, not a hand-made row; snapshot and map-row JSON round trips are tested (`jsonLeasePeerToB`); the peer-secret guard, `makeSyncHeaders` and the forwarder's header pass-through are tested. (reviewer A23)

### SYNC-42 The event-queue hook polls and logs every 2 s, and the drain sorts by wall clock
- **Location:** `packages/web/src/hooks/useEventQueue.ts:31-45`; `packages/web/src/lib/offline/events.ts:110-119,152-158`; `packages/web/src/lib/offline/sync.ts:23-28`.
- **What is wrong:** two of three counts per poll are JS-filtered scans, a `console.log` fires every 2 s while anything is pending, and every drain loop loads and sorts all pending rows by `timestamp` (wall clock) rather than `hlc` to take 50.
- **Fix (S):** `useLiveQuery` with a `[competitionId+status]` compound index (Dexie schema bump), drop the periodic log, order by `hlc` then `id`.
- **Verdict:** confirmed from code reading. The poll runs only while the tab is visible and no performance-sensitive page is mounted; cost scales with the backlog, normally small. (reviewer B21)

### SYNC-43 Dead and misleading code in the outbox and background modules
- **Location:** `packages/web/src/lib/offline/events.ts:84-94,121-134` (unused helpers); `lib/offline/db.ts:161-169,180,217` (`syncState` unused); `packages/api/src/liveresults.ts:616-627` and `online-input/puller.ts:358-368` (factories with no caller); `puller.ts:63` (`"roc" ? "roc" : "roc"` while the router stores `"sicenter"`); `packages/api/src/routers/liveresults.ts:226-241` (`setConfig`); duplicate `isNetworkFailure` (`lib/offline/control-outbox.ts:180-184`, `lib/trpc-links.ts:38-43`) and header logic (`main.tsx:51-65`, `lib/trpc.ts:20-31`).
- **What is wrong:** mostly dead code. The one item with behaviour: `liveresults.setConfig` lets an event manager write any `liveresultsTavid` and config straight to the event row with no caller in the app, so the pusher can be pointed at (and delete rows from) another competition's `tavid`. A saved `"sicenter"` protocol silently polls as ROC. `start.recorded` has no producer; StartStation is a read-only screen.
- **Fix (S):** delete or wire up; remove `setConfig` or validate it; reject `sicenter` until implemented; share one header function and one network-failure classifier.
- **Verdict:** confirmed by repo-wide grep. (reviewer B22)

### SYNC-44 Online-input endpoints let a race operator make the server fetch an arbitrary URL
- **Location:** `packages/api/src/routers/onlineInput.ts:103-121,123-139,161-188` (`raceOperateProcedure`, `endpointUrl: z.string()`, interval minimum 1 s at `:109`); `puller.ts:139-149,203-208`; `packages/shared/src/permissions.ts:40`.
- **What is wrong:** any race-crew member can point the puller at any host, including internal ones, and read the result back as `HTTP <status>` or a cleared error; `int;int;int;time` bodies are even parsed into punches. Polling can be set to 1 s against a third-party service.
- **Fix (S):** `manageProcedure` for config, `z.string().url()` restricted to http and https, block private and link-local targets on the cloud role, `min(5)` on the interval.
- **Verdict:** confirmed from code reading. Low on a self-hosted laptop, medium on the hosted cloud. (reviewer B23)

### SYNC-45 LiveResults competition credentials are predictable, and `tavid` allocation races
- **Location:** `packages/api/src/liveresults.ts:229-256` (`MAX(tavid)+1` then INSERT, no lock; Prisma update after the remote INSERT), `:148-150`; `schema.prisma:99`.
- **What is wrong:** the login is `md5("oxygen")` and `md5("oxygen_<eventId>")`, and event ids are sequential, so event N on every installation has the same pair. Two concurrent enables, or a failed Prisma update, leave an orphan remote row and allocate a second one.
- **Fix (S):** generate a random per-event password stored with the event; retry on a duplicate `tavid`; write the `tavid` locally with compensation. Same item as RES-29 in area 04.
- **Verdict:** confirmed from code reading. The outcome of a collision and what the login grants depend on the remote LiveResults schema, which is not in the repo. (reviewer B24)

### SYNC-46 Docs that no longer match the code (station and publishing side)
- **Location and items:**
  - `docs/system/offline-architecture.md:37-40,447-449`: single-owner services "config-flagged"; no flag exists (SYNC-14).
  - `docs/system/online-input-roc.md:66-69,114-116,147` and the comment `online-input/protocol.ts:16`: wrong config key (`online_input_config_<nameId>` versus `online_input_<eventId>_config`), a nonexistent `online_input_last_id_<nameId>`, and a mapping key the UI never writes (SYNC-13).
  - `docs/system/background-jobs-lease.md:107-124`: incomplete rather than false; it covers a poll clobbering operator config, not an operator save rewinding the watermark, which leads to the stall in SYNC-05 (not to duplicates).
  - `packages/web/src/main.tsx:83`: "pending offline mutations survive reload" (SYNC-25).
  - `packages/web/src/hooks/useEventQueue.ts:10-12`: "auto-drains when connectivity is restored" holds only when the browser fires `online` (SYNC-11).
- **Fix (S):** update each passage with the corresponding fix.
- **Verdict:** confirmed for four items; the background-jobs-lease item is partly confirmed as described. (reviewer B25)

---

## Leads (plausible, not independently verified)

- Whole-batch zod rejection blocks the station queue permanently: `sync.ts:23-28` always resends the oldest 50 pending entries, so one entry failing the schema at `packages/api/src/routers/events.ts:49-75` blocks the queue, with no path to `failed` (found while verifying SYNC-11).
- The `result.applied` apply calls `toRelative` on finish and start unguarded (`packages/api/src/routers/events.ts:402-403`), while the originating mutation guards `> 0 ? … : 0` (`cardReadout.ts:836-839`); a DNF applied through the journal may get a non-zero relative time (found while verifying SYNC-06).
- `useProjectionSync` is not gated on `ready` and hydrates competition B's Dexie projection from A's cached queries (`packages/web/src/hooks/useProjectionSync.ts:17-49`, called at `CompetitionShell.tsx:138`) (found while verifying SYNC-19).
- Event-row settings mutations run locally on the box during a lease and are then overwritten by the settings refresh (`packages/api/src/sync/settingsRefresh.ts:50-56`): `event.setCardFee`, the payment and receipt settings, `event.updateType`, `event.regenerateKioskKey`, `event.setGoogleSheetsConfig`, the AIR+ awake-hours mutation and `course.setOverprintCuts` (`routers/event.ts:284-294,927,942-994`; `routers/control.ts:1416-1427`; `routers/course.ts:1653-1662`) (found while verifying SYNC-35).
- The offline projection treats the registration payload's `clubId` (local club list id) as `eventorClubId` (`packages/web/src/lib/offline/projection.ts:115-116,129-131`) (found while verifying SYNC-12).
- `docs/system/online-input-roc.md` key names do not match the code (folded into SYNC-46; found while verifying SYNC-13).
- The ROC stall of SYNC-05 may also occur without a rewind if ROC returns two records with the same card, mapped code and time under different ids, in one batch or across batches (`puller.ts:247-283`, `punches_oi_dedup_idx`); not checked against real ROC data.

## Not reviewed, or could not be verified

- No runtime test runs: `node_modules` was absent, so no vitest, integration or E2E run, no Prisma validation run and no browser run. Only SYNC-05 and SYNC-09 (throwaway Postgres 16) and SYNC-36 (Node) were reproduced; everything else is from reading code.
- IAP and Cloud Run response behaviour (SYNC-23) is inferred, not exercised.
- Real ROC id ranges and duplicate behaviour (SYNC-26, the SYNC-05 lead) are unknown.
- The LiveResults remote schema (the `login` DDL, what the front end shows during the delete gap, `changed` semantics) is not in the repo (SYNC-15, SYNC-45). No live MySQL was contacted and no timings were measured.
- TanStack Query and Workbox behaviour (SYNC-16, SYNC-25, SYNC-28) is from library knowledge and, for the persister, the published npm source of the locked version, not from runtime. Dexie's `versionchange` default (SYNC-24) was not read.
- Router-side journal emitters (`runner.ts`, `race.ts`, `cardReadout.ts`, `classRouter.ts`, `course.ts`, `control.ts`, `drawRouter.ts`, `online-input/puller.ts`) were followed only for `result.applied`; cards, teams and control units were not traced for SYNC-02.
- `docs/system/background-jobs-lease.md` and `docs/architecture.md` were not compared line by line with the code. `docs/ops/venue-runbook.md`, `docs/system/registration-and-readout.md` and `AGENTS.md` were consulted by grep only.
- The payload size of `lease.exportSnapshot` for a mid-race re-checkout of a 2,000-runner event (Cloud Run caps responses at 32 MiB) was estimated, not measured.
- Not traced: whether stage-to-stage navigation is a client-side route change (SYNC-04), the Field-mode outbox call sites in the editor pages, `StartScreenPage`, the print offline store, and `SyncStatusIndicator.tsx` lines 260-452 (skimmed).
- Card readout and SI logic are left to area 05; Eventor sync to area 07. PR 254 was read only for `sync/lease.ts`, `legRoute.ts` and the two course columns.

**Found clean:**
- `packages/shared/src/hlc.ts` and `packages/shared/src/journal.ts` (pure helpers; `earliestWins` and `latestWins` are unused by the server apply path).
- `packages/api/src/leader.ts` lease SQL (DB-clock expiry, guarded single-statement upsert), apart from the races in SYNC-30 and SYNC-31.
- `sync/snapshotMaps.ts`, `snapshotGraphics.ts`, `mapRefresh.ts`: hash and size checks, fetch before the transaction, single-transaction apply, `oneAtATime`, seq-counter raise; only the version skew in SYNC-17 applies.
- `sync/googleIdToken.ts`, `ownership.ts`, `dropped-columns.ts`, `worker-bootstrap.ts`, `version-conflict.ts`, `db.ts`.
- Competition routing in `trpc.ts` (event resolved once per request; `peerProcedure` refuses without a secret; `lease.exportBlob` gated to referenced blobs), and the forwarder's batch classification.
- The ROC watermark compare-and-set against poll clobbering.
- Station side: `lib/offline/control-outbox.ts` (coalescing, `rev`, Web Locks, conflict and failed states, unit-tested), `card-read-payload.ts`, `projection.ts` and `projection-reads.ts` (flag-gated), `trpc-links.ts`, `session-recovery.ts`, `app-update.ts`, `legacy-caches.ts`, `useServiceWorkerUpdate.ts` (prompt-based update, no forced reload mid-event), `ClockSkewBanner.tsx`, `useOfflineMaps.ts`, `runner-directory-sync.ts`.
- Secrets: no LiveResults, ROC or Eventor secret is returned to the client by the routers read, and the LiveResults connection string is fetched server-side and not logged.

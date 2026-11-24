# Area 07 review: Eventor and external import/export

Part of the 2026-11 full code review of `main` (df5460c3), plus the Eventor part of PR #254 (branch `claude/project-thread-avzbks`). Review only: no code was changed.

**Scope.** Eventor client and router (`packages/api/src/eventor.ts`, `routers/eventor.ts`), API key store, runner/club directory sync, `eventor-pace.ts`, the Eventor UI in `EventPage.tsx` / `CompetitionSelector.tsx` / `EventorKeysPanel.tsx`; LiveResults push (`liveresults.ts`, `routers/liveresults.ts`, supervisor wiring); IOF XML 3.0 CourseData and Purple Pen import/export (`iof-course-*.ts`, `ppen-course-*.ts`, `course-export.ts`, `importCourses` in `routers/course.ts`); the `external` read router.

**Method.** Two Fable reviewers read the scope in full, one for Eventor and one for the other formats. Each of the 29 findings then went to its own fresh Fable verifier, which saw only the location and the claim and was asked to disprove it. None was refuted. Four were narrowed (EVT-13, EVT-16, EVT-19, EVT-28); their text below is the narrowed version. Severity is the final call after weighing the reviewer and the verifier.

**Not repeated here.** These are already reported by the ZeroTime/results review (`04-zerotime-results.md`): RES-02 (Eventor times stored as clock time, and a re-sync overwriting every runner), RES-11, RES-14, RES-21, RES-22, RES-23, RES-29.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 7 |
| Medium | 14 |
| Low | 8 |

27 are confirmed and 2 are plausible (EVT-14 and EVT-22 depend on how Eventor itself behaves).

**Fix these first:**
1. **EVT-01 and EVT-02.** "Sync from Eventor" is the normal way to pull late entries at the arena. It cancels runners who have already finished, and it undoes desk edits: a rental card is set to NULL and a class move is reverted. Both are S/M fixes in one function.
2. **EVT-03.** One failed sub-request during a sync clears `noTiming` on every class, so children's classes are ranked and timed, including in the Eventor upload. S.
3. **EVT-05.** The default course import mode, "replace all", wipes courses, controls and class links in separate commits before rebuilding them. A dropped connection mid-import leaves readout with no courses. M.
4. **EVT-06.** After a venue checkout, the venue and the cloud both push to the same LiveResults competition. Each cloud cycle deletes finishes the cloud has not received yet. S–M.
5. **EVT-07.** Every Purple Pen export is malformed XML. It is a one-line fix.

The key store logic, the directory upsert SQL, `eventor-pace.ts`, XML output escaping, XML parser entity safety, environment selection for sync and push, export route authorisation and LiveResults router authorisation are clean. There is no CSV export anywhere in the code.

---

## High

### EVT-01 Re-sync cancels runners who already have a result
- **Area / category:** Eventor sync; functional (data corruption mid-event).
- **Location:**
  - `packages/api/src/routers/eventor.ts:1183-1199`: the withdrawn pass checks only `r.status !== cancel`.
  - `:958-983`: the `existing` query has no `removed` filter.
  - `:1140`: `seen` is filled only in the entries loop. The results-only loop (`:1144-1181`) never adds to it.
  - `packages/api/src/eventor.ts:700-701`: `fetchEntries` returns `[]` when `EntryList.Entry` is missing.
  - UI promise: `packages/web/src/i18n/locales/en/event.json:137` and `sv/event.json:137` say that only runners *without a race result* are cancelled.
- **What is wrong:** every runner with an `eventorPersonId` that is missing from this sync's entry list is set to Cancelled. The code never looks at the local status, finish time or card. A runner who appears in Eventor only in the result list is also cancelled, because the results loop never marks it as seen, and it stays cancelled on every later sync. The previous status is not kept, although the comment at `:927-930` claims audit history.
- **Scenario:**
  - A club swaps the competitor on an entry in Eventor, or deletes the entry, after the import. The original runner still runs and is read out OK.
  - The organiser presses Sync to pull late entries. That runner becomes Cancelled and drops out of the results.
  - If Eventor returns a 200 with an empty `<EntryList/>`, every Eventor-imported runner is cancelled in one click.
- **Fix (S):**
  - In the withdrawn pass, skip runners that have a finish time, a `cardId` or a status other than unknown/no-timing, and skip `removed` rows.
  - Call `seen.add(result.personId)` in the results loop.
  - Refuse the pass when `entries.length === 0 && existing.length > 0`.
  - Add integration tests beside `eventor-reentry.test.ts`: a finished runner missing from the snapshot keeps its status, and an empty snapshot cancels nobody.
- **Confirmed** from code. The verifier traced the whole `sync` mutation and found no guard. Not run.

### EVT-02 Re-sync reverts local card, class, name and club edits, and wipes a local card when Eventor has none
- **Area / category:** Eventor sync; functional (data loss in normal arena use).
- **Location:**
  - `packages/api/src/routers/eventor.ts:1027-1031`: `claimCardNo(result?.cardNo || entry.cardNo, found.id, found.cardNo)`.
  - `:152-159`: the claimer returns `null` for a raw 0 before the fallback is consulted. The fallback is used only on an owner conflict (`:156`).
  - `:1033-1048`: `needsUpdate`.
  - `:1050-1059`: the update writes name, cardNo, classId, clubName, eventorClubId, birthYear and sex.
- **What is wrong:** for every runner matched by Eventor person id, Eventor wins on card, class, name, club, birth year and sex. When the Eventor entry has no card, the local card is set to NULL. When the Eventor class id is unknown locally, the class is set to NULL (`:1036`, `:1055`). There is no record of local edits; the only such guard in the sync is `length_source`, for course lengths. A club-name-only edit survives until another field differs, because `clubName` is not compared.
- **Scenario:**
  - The desk gives a rental card to an entrant who entered without one, or moves a runner to another class.
  - The organiser syncs to pull late entries. The card goes back to NULL, or the class goes back to the Eventor one.
  - At readout the card matches nobody, or the runner is evaluated against the wrong course.
  - This does not need any results in Eventor, so it is separate from RES-02.
- **Fix (M):**
  - Minimum: treat a raw 0 as "no opinion" (`nextCardNo = raw > 0 ? claim(...) : found.cardNo`), and do not overwrite `cardNo` or `classId` once the runner has a `cardId`.
  - Better: store the last values imported from Eventor (columns or a JSON snapshot). Apply a field only when Eventor's value changed since the last sync and the local value still equals the previously imported one.
  - Tests: a local rental card survives a sync, and a local class move survives a sync.
- **Confirmed** from code. `eventorCardNo.test.ts` covers only the conflict case.

### EVT-03 A failed `export/classes` request makes a re-sync clear `noTiming` on every class
- **Area / category:** Eventor sync; functional (wrong results).
- **Location:**
  - `packages/api/src/eventor.ts:569`: every class starts as `noTiming: false`.
  - `:577-585`: any rejection is swallowed, with no log.
  - `:668`: `fetchNoTimingClassNames` returns an empty set for a 200 response with no `ClassList`/`Class`.
  - `packages/api/src/routers/eventor.ts:312-333`: `existingRow.noTiming !== ec.noTiming` leads to `class.update({ noTiming })`. Called from `sync` at `:935-936`.
- **What is wrong:**
  - "Could not fetch the no-timing list" is treated the same as "no class is no-timing". It is triggered by any non-2xx, a 403, a reset, a DNS failure or an odd 200 body, and the code comment calls the endpoint "may be unavailable".
  - The same update also overwrites local edits of name, sex and age limits on every successful sync. `sortIndex` and `classType` are overwritten only when Eventor's value is set.
- **Scenario:**
  - On poor arena network the organiser syncs, and `export/classes` fails while `eventclasses` succeeds.
  - "Inskolning"/"U1" lose `noTiming`. The readout and race payloads (`cardReadout.ts:263`, `race.ts:69`) and the Eventor upload placements (`routers/eventor.ts:1649`, `:1757`) now rank and time those children.
  - The sync reports only a `classesUpdated` count.
  - Existing runners keep their own `NoTiming` status, which comes from the entry.
- **Fix (S):**
  - Return `noTiming: undefined` when the enrichment failed or came back empty, and skip that field in `needsUpdate` and `data`.
  - Log the failure and report "class details incomplete" in the sync stats.
  - Test: a class with `noTiming` undefined against an existing `noTiming = true` row.
- **Confirmed** from code.

### EVT-04 Eventor's result position is stored as the start number and overwrites drawn numbers
- **Area / category:** Eventor import/sync; functional.
- **Location:**
  - `packages/api/src/eventor.ts:972`, `:990` (`startNo: resultPosition`). The interface comment at `:136` says so.
  - Written at `packages/api/src/routers/eventor.ts:805`, `:847`, `:1087`, `:1130` and `:1175`.
- **What is wrong:** `<ResultPosition>`, the finishing place, goes into `runners.start_no`. On re-sync, `:1087` overwrites the local start number whenever `needsUpdate` is true. Because of RES-02, the start and finish times differ for every runner with a result, so in practice `needsUpdate` is always true.
- **Scenario:** start numbers are drawn, results are uploaded mid-event, and the organiser syncs for late entries. Every placed runner's start number becomes their place (1, 2, 3 in each class, so duplicates across classes). Start lists and bib lookups are wrong. No test covers the field.
- **Fix (S):** drop `startNo` from `EventorResult` and from the five writes, and keep `bib`. Add an integration test that a sync with results leaves `startNo` untouched. Fix it together with RES-02, in the same code.
- **Confirmed** from code.

### EVT-05 "Replace all" course import is not transactional; a failure mid-import leaves no courses, controls or class links
- **Area / category:** course import (IOF XML / Purple Pen); stability (partial write).
- **Location:**
  - `packages/api/src/routers/course.ts:1883-1899`: the wipe is three auto-committed `updateMany` calls (courses removed, controls removed, `class.courseId = null`).
  - Then sequential awaited writes on `ctx.db`, ending at `:2373`. `persistStructure` (`course-structure.ts:148`) itself says "call inside the write transaction".
  - `:2272-2294`: class mapping, applied last.
  - `:2341`: the journal append.
  - `:2296-2307`: a comment says the transaction was left out on purpose.
  - `packages/web/src/components/CourseImportDialog.tsx:30`: replace-all is the default (`useState(true)`).
- **What is wrong:** a throw after the wipe leaves the wipe committed and the rebuild partial: a dropped DB connection, a statement timeout, a process restart, or an exception in `persistStructure`, `syncVariants` or `writeImportedObjects`. The comment's claim that "a crash in between loses only the ship" does not hold for replace-all.
- **Scenario:**
  - On race morning the organiser re-imports a corrected course file, and the connection drops after the wipe.
  - Every class has `courseId = null` and every control is removed.
  - Readout resolves `runner.courseId ?? runner.class?.courseId` (`cardReadout.ts:196`, `race.ts:39`), so every runner who relies on the class's course has none. No journal entry was written.
  - Recovery takes one successful re-import, because the rows are soft-deleted and restored by name. Manual class mapping may have to be redone.
- **Fix (M):**
  - Wrap the wipe, the rebuild and the journal append in one `ctx.db.$transaction(async (tx) => …)` with a raised timeout, and pass `tx` to the helpers.
  - Minimum (S): put the three wipes and the control/course upserts in one transaction.
  - Add an integration test that injects a failure after the wipe and asserts the old courses, controls and class links are intact.
- **Confirmed** from code. Validation that can throw on bad input runs before the wipe, so the trigger is an infrastructure failure.

### EVT-06 A checked-out venue node and the cloud both push the same event to the same LiveResults competition
- **Area / category:** LiveResults / offline-first; stability, docs disagree with code.
- **Location:**
  - `packages/api/src/sync/lease.ts:251-253`, `:285`: the snapshot exports the whole event row.
  - `:314`, `:320-323`, `sync/dropped-columns.ts:10`: the import strips only `id`, `mapPipeline` and `overprintCutsVersion`, so `liveresultsTavid` and `liveresultsConfig` arrive verbatim.
  - `packages/api/src/liveresults.ts:727-799`: `reconcileEnabledPushers` arms every enabled event and never checks the event lease.
  - `packages/api/src/leader.ts:106-109`: the background lease lives in each node's own database.
  - `packages/api/src/index.ts:165`: the supervisor always starts.
  - Docs: `docs/system/offline-architecture.md:37-39` ("config-flagged so a venue copy never double-runs them") and `:447-449` ("must never double-push").
- **What is wrong:** the documented config flag does not exist. `NODE_ROLE` is informational (`sync/nodeIdentity.ts:11`) and is not read by the supervisor or the pusher. After checkout both nodes push to the same `tavid` and the same `dbid = runner.seq` on independent timers. Any node with internet has the credentials (`liveresults.ts:176-187`).
- **Scenario:**
  - LiveResults is enabled in the cloud, and the event is checked out to the arena laptop.
  - A runner finishes on the laptop, but the journal entry has not reached the cloud yet.
  - Each cloud cycle sees the runner as Unknown, deletes their results rows (`liveresults.ts:401-414`) and re-inserts only the start.
  - The public finish flickers in and out until shipping catches up.
- **Fix (S–M):**
  - In `reconcileEnabledPushers`, skip events whose active lease is held by another node, so that only the lease holder pushes. The alternative is to implement the documented flag; either way, correct the doc.
  - Add a reconciler test with a lease held elsewhere.
  - The ROC online-input puller (`reconcileEnabledPullers`) has the same wiring and should get the same check. Not verified.
- **Confirmed** from code. The size of the visible effect depends on shipping lag and was not measured.

### EVT-07 Every Purple Pen (.ppen) export is malformed XML
- **Area / category:** Purple Pen export; functional, tests that cannot fail.
- **Location:**
  - `packages/api/src/ppen-course-export.ts:229-233`: builder options without `suppressBooleanAttributes: false`.
  - The `"true"` attributes are at `:139`, `:186`, `:200`, `:205` and `:207`.
  - Compare `iof-course-export.ts:199-206` and the comment at `:143-144`, which set the option for exactly this reason.
- **What is wrong:** with the fast-xml-parser default, an attribute whose value is `"true"` is written bare. Every export, even one with no courses, contains bare `restrict-to-page-size`, `left-to-right`, `scale-sizes-circle-gaps` and `blend-purple`. The tests (`__tests__/ppen-course-export.test.ts:53-60`) only use `toContain` on other substrings. They round-trip through Oxygen's own parser, which silently drops bare attributes.
- **Scenario:** Courses → Export → Purple Pen gives `<print-area automatic="false" restrict-to-page-size left="1"/>`, which a conforming XML reader rejects.
- **Fix (S):** add `suppressBooleanAttributes: false`. Add a test that `XMLValidator.validate(xml) === true` and that `restrict-to-page-size="true"` is present. Open one file in real Purple Pen once after the fix.
- **Confirmed** by reproduction on fast-xml-parser 5.12.1 (the pinned version) with the repo's options. Python expat rejects the output ("not well-formed"), and the library's own validator flags it. With the option set, the output is well-formed. That Purple Pen itself rejects the file is inferred.

---

## Medium

### EVT-08 Eventor sync writes runner state on the cloud while the event is leased to a venue node
- **Area / category:** Eventor sync / offline-first; stability (divergence).
- **Location:**
  - `packages/api/src/routers/eventor.ts:903`: `sync` is a `manageProcedure`.
  - Compare `packages/api/src/trpc.ts:176-180` (`raceProcedure` / `assertRaceWritable`) and `:303` (`manageRaceProcedure`).
  - `packages/shared/src/cloud-ownership.ts:18`: the `"eventor."` prefix is forwarded to the cloud.
  - `packages/api/src/sync/venueForwarder.ts`: refreshes only map rows afterwards.
  - Docs: `docs/system/offline-architecture.md:186-188` call this "unsupported".
- **What is wrong:** the sync creates, updates and cancels runners with plain `db.runner.*` calls, with no lease guard, no journal entries and no transaction. The fields it writes are venue-owned during a lease. The button is disabled only while pending or when there is no API key (`EventPage.tsx:400`), and the panel shows regardless of the lease.
- **Scenario:** while the event is leased to the arena laptop, someone presses Sync in the cloud UI. It also works from the laptop if the laptop has a local key. The cloud copy gets new runners and cancel/card/class rewrites that never reach the venue, while the UI reports success. After check-in, the cloud keeps those rewrites for every runner the venue did not journal.
- **Fix (S):** switch `sync` to `manageRaceProcedure`, or call `assertRaceWritable` first, and disable the button from the lease state. Later (L): journal the sync's writes.
- **Confirmed** from code. Not checked: whether a cloud-created runner holding a card can make a later venue journal entry trip `runners_event_id_card_no_key`, which would stall shipping and raise this to high.

### EVT-09 Import and sync write row by row without a transaction; a failure leaves a half-imported event
- **Area / category:** Eventor import; stability and performance.
- **Location:**
  - `packages/api/src/routers/eventor.ts:694-730`: only the event row and its meta are in a transaction, and `eventorLastSync` is set at `:703`.
  - `:782`, `:831`: one `db.runner.create` per entry, awaited in turn.
  - `:229-265`: `deriveClassFees` runs last (`:856`).
  - Sync writes at `:1050`, `:1107`, `:1159` and `:1190`.
  - Claimer key `person:<id>` at `:789-792`, `:838`.
- **What is wrong:**
  - After the event row commits, about 2,000 sequential inserts run in one HTTP request with no transaction.
  - An abort leaves an event that looks imported but has only some runners and no class fees. Retrying the import then fails on the slug (EVT-11).
  - Two entries with the same `personId` (including 0) and the same card share the claimer key, so both get the card and the second insert violates `runners_event_id_card_no_key`.
  - Id-less entries are stored with `eventorPersonId 0`, so on sync they all collapse onto one runner (`:984-986`, `:1014`).
- **Scenario:** a large import is interrupted by an API restart, a DB drop or the duplicate-card case. The event list shows the event with 700 of 2,000 runners and no warning. In one ordering of the duplicate case, Sync hits the same P2002, so the event cannot be completed at all.
- **Fix (M):**
  - Build the rows in memory, `createMany` them in batches inside the same transaction as the event row, and set `eventorLastSync` last.
  - Key the claimer on `entry:<eventorEntryId>`.
  - Batch or wrap the sync's runner phase in a transaction.
  - Test: an entry list with a duplicate person and card imports without error.
- **Confirmed** from code. How often Eventor returns such duplicates is not known.

### EVT-10 The entry parser drops class and card when Eventor repeats `EntryClass` or `CCard`, and stores non-SI cards as SI numbers
- **Area / category:** Eventor import; functional.
- **Location:**
  - `packages/api/src/eventor.ts:731-736` and `:1046-1047` (`fetchCompetitors`).
  - The `isArray` list at `:30-42` contains neither path.
  - `PunchingUnitType` appears nowhere in the repo. The only punching-system filter is on the `ControlCard` path (`:1157-1168`).
- **What is wrong:** fast-xml-parser turns a repeated element into an array, so `.EventClassId` / `.CCardId` read `undefined`, which becomes 0. A single Emit card is stored as an SI number.
- **Scenario:**
  - A runner with both an SI and an Emit card in Eventor is imported with no card (unless a result supplies one). With EVT-02, every sync then wipes the card the desk typed in.
  - An entry with two `EntryClass` elements is imported without a class, and on sync an existing runner's class is set to NULL.
  - Emit numbers can collide with real SI cards.
- **Fix (S):**
  - Normalise both to arrays. Pick the first `EntryClass` by `@_sequence`, and the `CCard` whose `PunchingUnitType/@_value` is SI or absent.
  - If you use `isArray`, use full jpaths: `EntryList.Entry.EntryClass`, `EntryList.Entry.Competitor.CCard`, `CompetitorList.Competitor.CCard`, and the `Person.CCard` variant. The existing relative `"Competitor.ControlCard"` entry probably never matches.
  - Add parser tests from captured XML (EVT-21).
- **Confirmed**: the parser behaviour was reproduced on 5.12.1. How often Eventor sends repeated elements was not checked.

### EVT-11 `importEvent` has no slug-collision handling; a soft-deleted event blocks re-import
- **Area / category:** Eventor import; functional.
- **Location:**
  - `packages/api/src/routers/eventor.ts:687-696`: slug from `sanitizeNameId(input.eventName)`, then a bare `tx.event.create`.
  - Unique index: `prisma/migrations/20260517_init/migration.sql:51`, `schema.prisma:100`. It is not partial on `removed`.
  - Soft delete at `routers/event.ts:328-331`. The only hard delete is the all-or-nothing `purgeDeleted` (`:336-341`).
  - `event.create` has the same problem: it lets a removed row through at `:258` and hits the same index at `:264`.
- **What is wrong:** a name that sanitises to an existing `name_id`, including a soft-deleted one, fails with the raw multi-line Prisma P2002 text (`CompetitionSelector.tsx:900-902`). It fails after three Eventor fetches. `sanitizeNameId` folds å/ä/ö and punctuation and truncates at 64 characters (`db.ts:95-105`), so different names can collide too. The import UI gives no way to choose a slug.
- **Scenario:** an organiser imports "Vårserien 1" to rehearse, deletes it, and imports it again for the real event, and the import fails. The same happens for a yearly event with an unchanged name. With auth on, only an admin can purge, and purging hard-deletes every soft-deleted event.
- **Fix (S):** look up the slug first. If it is taken, append the date or the Eventor event id. Throw a readable CONFLICT when a live event is already linked to the same Eventor id and env. Do the same in `event.create`. Integration test: import, delete, import again.
- **Confirmed** from code. Nothing is written before the failure.

### EVT-12 Runner-directory and Eventor-proxy endpoints are `publicProcedure`
- **Area / category:** Eventor router; security and abuse.
- **Location:**
  - `packages/api/src/routers/eventor.ts:582` (`events`), `:604` (`searchEvents`), `:630` (`eventDetail`), `:1220` (`syncRunnerDb`, a mutation), `:1363` (`runnerDbStatus`), `:1376` (`searchRunnerDb`), `:1421` (`lookupByCardNo`), `:1447` (`clubMembers`), `:1474` (`runnerDbDump`) and `:1898` (`fetchEntryHistory`, a mutation).
  - `trpc.ts:108`: `publicProcedure` does no user check. `index.ts` has no auth hook or rate limiter in front of `/trpc`.
  - This contradicts `docs/system/authentication.md:39-47`.
- **What is wrong:** with auth on, a caller who is not an invited user can do all of the following:
  - Download the whole federation directory (name, birth year, SI card, club) with `runnerDbDump`, which has no `take`.
  - Make the server call Eventor with the stored key: `events`, `eventDetail`, `clubMembers` for any organisation, and `fetchEntryHistory` with `force: true` for 20 events per call.
  - Trigger `syncRunnerDb` with any `env`. It loads the full export into memory and has no in-flight guard.
  - `clubMemberCache` (`:164`) is never evicted.
- **Scenario:** a proxy-authenticated but uninvited account, or anyone reaching the API port without the proxy, scrapes personal data, or loops `syncRunnerDb`, which holds several large parses at once and spends the club key's Eventor quota on race day. With `AUTH_MODE=off` the API is open by design.
- **Fix (S–M):**
  - Move `events`, `searchEvents`, `eventDetail`, `runnerDbStatus` and `fetchEntryHistory` to `authedProcedure`.
  - Move `syncRunnerDb` to `adminProcedure` with a single-flight guard.
  - Put `searchRunnerDb`, `lookupByCardNo`, `runnerDbDump` and `clubMembers` behind an authed-or-kiosk-key gate. Check which station pages call them; `useStationSync.ts` prefetches the dump.
  - Extend `permissions.test.ts`.
  - The same pattern exists outside this area (`clubRouter.ts:222`, `registrationTrends.ts:131/174/242/305/321`, `testLab.ts:182`, `mapImport.ts:131/207`, `lease.ts:141`) and belongs to the API/auth area.
- **Confirmed** from code.

### EVT-13 No timeout on Eventor requests or uploads; the UI reports failure while the upload continues
- **Area / category:** Eventor client; stability.
- **Location:**
  - `packages/api/src/eventor.ts:219-221` (`eventorFetch`), `:1098-1100` (`fetchCachedCompetitors`) and `:1330-1334` (`postZip`). Only `fetchClubLogo` (`:1215-1221`) uses a timeout.
  - `docker/nginx.conf:24` and `docker/nginx.host-db.conf:24`: `proxy_read_timeout 120s`.
  - Push buttons: `EventPage.tsx:419-420` and `:439-440`.
- **What is wrong:** with undici's defaults (10 s to connect, 300 s for headers, 300 s of body idle), a request on a link that connects but then stalls waits up to about 5 minutes. In Docker, nginx returns a 504 after 2 minutes, so the UI shows "push failed" while the upload may still be going through. `postZip` returns nothing, so the outcome is unknown. After a reload the button is enabled again, and nothing guards against a second concurrent upload (`routers/eventor.ts:1779`).
- **Scenario:** on a weak mobile link the organiser presses "Push results". It stalls, the page shows a failure at 2 minutes, they press again, and two uploads are in flight.
- **Fix (S):**
  - Pass `signal: AbortSignal.timeout(n)` to every call, well under 120 s (`map-store/dem-cog.ts:112` already does this).
  - On an abort, tell the user that the upload outcome is unknown.
  - Add a per-event in-flight guard on both pushes.
  - Unit test with a never-resolving fetch and fake timers.
- **Confirmed** from code, narrowed. The original "hangs for five minutes" is about 2 minutes in the UI under nginx, and it applies only once a connection has been made. The undici defaults are from knowledge, not measured.

### EVT-14 A class without an Eventor id may make Eventor reject the whole upload
- **Area / category:** Eventor upload; functional.
- **Location:**
  - `packages/api/src/eventor.ts:1364-1366`, `:1393-1397`, `:1505-1509` and `:1534-1538`: grouping by `classExtId || className`, with `Class: { Id: undefined, Name }`.
  - `packages/api/src/routers/eventor.ts:1747-1748` and `:1838-1839`: `className: cls?.name ?? "Unknown"`.
  - Classes are loaded with `removed: false` (`:1553-1555`, `:1822-1824`), so a runner in a soft-removed class also becomes "Unknown".
- **What is wrong:** locally created classes, classless runners and runners in deleted classes are uploaded as a `ClassResult`/`ClassStart` with a name and no `Id` (reproduced: the `Id` element is dropped). There is no pre-check, and `dryRun` returns only a count. A rejection shows Eventor's raw text (`EventPage.tsx:492`, `:504`), which may not name the class.
- **Scenario:** an "Öppen motion" class is added at the arena, or one runner is left without a class. If Eventor rejects the file, the result upload fails at the end of the event until someone finds the cause.
- **Fix (S):** before posting, collect the groups without `classExtId`. Skip them and return `skippedClasses` (names and counts), shown in the sync panel. Use `dryRun` to list them before a push.
- **Plausible.** The Oxygen side is proven and reproduced. Whether Eventor rejects an Id-less class (the "Must be exactly one event class" text at `eventor.ts:1319-1320`) could not be checked; the 400 in `eventor-upload.test.ts:144` is a mock.

### EVT-15 The global runner directory can be filled from Test-Eventor
- **Area / category:** runner directory; functional (wrong data across competitions).
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:534-536`: sends the open event's env. The club sync does the same (`:118`).
  - `packages/api/src/routers/eventor.ts:1220-1283`.
  - `packages/api/src/runner-directory-sync.ts:57-70` and `:90-99`: upserts keyed only on Eventor id.
  - `schema.prisma:366-395`: no env column. No delete path exists.
  - `lookupByCardNo` (`routers/eventor.ts:1421-1427`): `findFirst` with no order. The client lookup in `RegistrationDialog.tsx:124-129` is just as ambiguous.
- **What is wrong:** `runner_directory` and `club_directory` are global and feed registration autofill and card lookup for every event. They are filled from whichever environment the open event is linked to, and `syncRunnerDb` takes `env` from the client. Rows only accumulate.
- **Scenario:** the organiser rehearses on a Test-Eventor event and syncs the directory there. At the real event, registration autofills Test-Eventor cards and clubs. Stations also keep the stale dump in their offline cache. A prod sync repairs the rows that prod returns, but rows that exist only in Test-Eventor stay for ever.
- **Fix (S):** always sync the directories from prod, falling back to test only when no prod key exists and saying so in the UI. Alternatively, add an env column and filter reads. Order card lookups by `updatedAt desc`.
- **Confirmed** from code. Whether Test-Eventor shares person ids with prod (overwrite) or not (extra rows) was not checked.

### EVT-16 LiveResults: the connection settings are fetched every cycle, and a bad response tears down the pool; queries have no timeout
- **Area / category:** LiveResults; stability on poor network.
- **Location:**
  - `packages/api/src/liveresults.ts:172`: the header says "credentials cached".
  - `:177-188`: `fetch` with no signal and no `resp.ok` check.
  - `:190-210`: `getLiveResultsPool` refetches on every call. `await pool.end()` is at `:194`.
  - `:198-207`: `connectionLimit: 5`, with `queueLimit` unlimited by default.
  - `:315-505`: one connection is held for the whole `syncAll`.
  - `:591`: `setInterval` with no in-flight guard.
- **What is wrong:**
  1. Every `syncAll` and `updateCompetitionMeta` first POSTs to `getConnectionSettings.php`, with only undici's defaults as timeouts. `ensureCompetition` does this only when no `tavid` is stored.
  2. A 5xx or error body from the endpoint or its proxy is accepted as a connection string. The healthy pool is ended, which fails any sync in flight on it, and a new pool is built from garbage. It heals on the next good response. A captive portal cannot cause this, because the endpoint is HTTPS.
  3. No `conn.execute` has a timeout. TCP keep-alive is on, but at the OS default delay, so it does not detect a dead link. When the existing connections are dead but new HTTPS requests work (for example, a 4G reconnect), each tick takes another dead connection. After 5 ticks every later sync, for every event, queues with no limit until TCP gives up, roughly 15 minutes later. Meanwhile `lastError` stays empty, and `pool.end()` itself blocks on the hung connections.
- **Scenario:** at the arena on a flapping 4G link, live results stop updating for every event for many minutes, and the status panel shows no error.
- **Fix (S–M):**
  - Cache the connection string, and refetch only after a connection or auth error or after N minutes.
  - Add `AbortSignal.timeout(10_000)` and `if (!resp.ok) throw`.
  - Validate the string has 4 `;`-separated parts before touching the pool.
  - Swap pools without ending one that is in use.
  - Pass `{ sql, timeout }` to every query, or set `keepAliveInitialDelay` and a per-cycle deadline.
  - Add a per-event in-flight guard (see RES-14).
  - Unit tests for the non-OK and malformed-string paths.
- **Confirmed** from code and the mysql2 3.24.6 defaults, narrowed: no captive portal, and keep-alive is on but ineffective.

### EVT-17 Re-importing courses renames every start and finish, and collapses named starts into one
- **Area / category:** course import; functional (course data corruption).
- **Location:**
  - `packages/api/src/routers/course.ts:1979-1988`: the name is built from the file id's trailing digits, defaulting to "1".
  - `:2024-2031`: a row matched by file id is written with that name.
  - `:1914-1925`: `controlByKey` is built once and not updated in the loop.
  - `:2148-2153`: `startName` is built the same way and used at `:2182` and `:2202`.
  - Export: `course-export.ts:94` (by name) and `iof-course-export.ts:105-109` (the first of duplicate ids wins).
  - Readers resolve by `startName` (`course-structure.ts:60`, `course.ts:401-402`).
- **What is wrong:** the importer ignores the start/finish id except for its trailing digits. A matched start is renamed, and two starts without distinct numbers both become "Start 1". The next export points every course at the first one.
- **Scenario:**
  - An event has "Start Nord" and "Start Syd". Oxygen's IOF export writes those as ids.
  - Re-importing into the same event renames both to "Start 1". Importing into a fresh event creates two "Start 1" rows.
  - The next IOF export has one site, so the Syd courses get Nord's position. Inside Oxygen `startName` is ambiguous too.
  - A single renamed start always reverts to "Start 1" on re-import.
- **Fix (S–M):** keep the file id as the name unless it is a tool-generated form (`STA\d+`, `S\d+`, `FIN\d+`, `F\d+`, `M\d+`). Never rename a matched existing start or finish. Add new rows to `controlByKey`. Add a round-trip integration test with two named starts.
- **Confirmed** from code for the IOF path. The `.ppen` path was not traced.

### EVT-18 The IOF and Purple Pen parsers coerce numeric-looking names and ids ("5.0" → "5", "01" → "1")
- **Area / category:** course import; functional (silent data change).
- **Location:**
  - `packages/api/src/iof-course-parser.ts:148-160` and `ppen-course-parser.ts:26-45`: `XMLParser` without `parseTagValue: false`.
  - Consumers: `iof-course-parser.ts:215`, `:236`, `:257`, `:273`, `:300-301` and `ppen-course-parser.ts:176`, `:217`.
  - Matching: `routers/course.ts:2156`, with the create at `:2193-2194` and the case-insensitive lookup at `:2112-2116`.
- **What is wrong:** element text that looks like a number becomes a JS number before `safeStr`. This loses leading zeros, trailing-zero decimals, a `+` prefix and hex/exponent forms. Attributes are not affected, and "2.5" survives.
- **Scenario:** a club names courses "5.0" and "10.0", or "01" to "12", in the course editor or through OCD import. An IOF or ppen re-import yields "5", which does not match "5.0", so a second course is created and the class mapping keys no longer match. Two names in one file, such as "5" and "5.0", collapse into one. `docs/system/iof-coursedata-export.md:6` promises that the file re-imports.
- **Fix (S):** add `parseTagValue: false` to both parsers; `safeFloat` already accepts strings. Add tests for "01", "5.0" and a leading-zero control id, and a round-trip test.
- **Confirmed** by reproduction on 5.12.1: `031`→31, `01`→1, `5.0`→5, `1.50`→1.5, `1e2`→100, `0x1F`→31, `007`→7.

### EVT-19 Times after midnight are uploaded with the event date, and `Event/StartTime` is always 00:00:00
- **Area / category:** Eventor upload; functional.
- **Location:**
  - `packages/api/src/eventor.ts:342-349` (`formatIofTime`).
  - Results: `:1375`, `:1388-1391`, `:1422` (running time only when `finishTime > startTime`) and `:1463`.
  - Start list: `:1517`, `:1529-1532` and `:1575`.
  - Callers that drop the day: `packages/api/src/routers/eventor.ts:1752-1753` and `:1843`, through `toAbsolute` (`timeConvert.ts:24-27`).
- **What is wrong:**
  - The callers pass wrapped clock times and a single event date, so a start or finish after midnight is written with the event date.
  - The running time is then omitted, while `Status` OK and `Position` are still sent.
  - `Event/StartTime/Time` is always `00:00:00`, because `zeroTime` is never passed.
  - No timezone offset is written.
  - A `T24+` output is possible only for a future caller that passes unwrapped values.
- **Scenario:** at a night event with zero time 22:00, a runner starts at 23:30 and finishes at 00:20. The upload says OK, placed, with no time and a finish before the start.
- **Fix (S):** pass relative values and `zeroTime` to the builders. Compute the running time from the relative values. Roll the date forward at 24 h or more. Use `zeroTime` for `Event/StartTime`.
- **Confirmed** from code. The title was narrowed from "invalid xsd:dateTime" to "wrong date".

### EVT-20 LiveResults panel: settings changed while the push is running are never saved, and the public link never appears
- **Area / category:** LiveResults UI; functional, dead code.
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:766` and `:792`: the country and public inputs stay enabled while running; interval is disabled at `:752`.
  - `:799`: Save is shown only when not running.
  - `:667-684`: `handleToggle`.
  - `:721`: the public link.
  - `packages/api/src/routers/liveresults.ts:107-135`: `saveConfig` never calls `updateCompetitionMeta`, whose only caller is `enable` at `:166`.
  - `:130`: `publicUrl` is written only from input that no client sends.
  - `:157-174`: the meta update on enable only logs on failure.
  - `:226-241`: `setConfig` accepts any record, and the reconciler (`liveresults.ts:764-767`) accepts an interval `> 0`.
- **What is wrong:**
  1. Ticking "public" or changing the country while the push is running changes only React state. The remote listing is untouched until the push is turned off and on again, and a reload discards the edit.
  2. `publicUrl` is always empty, so the link never renders.
  3. A transient failure of the meta call on enable leaves the competition unlisted while the panel shows it live.
  4. The unused `setConfig` bypasses the 5–3600 s bound. For example, 0.01 s gives overlapping syncs every 10 ms.
- **Scenario:** the organiser enables the push and then ticks "public competition". The event never becomes listed, and no error is shown.
- **Fix (S):**
  - Show Save while running, or disable the inputs, and have `saveConfig` call `updateCompetitionMeta` when a tavid exists.
  - Set `publicUrl` from the tavid in `enable`.
  - Return the meta failure from the procedure.
  - Delete `setConfig`.
- **Confirmed** from code.

### EVT-21 The Eventor parsers and the push payload builders have no tests against real data
- **Area / category:** Eventor; tests.
- **Location:**
  - `packages/api/src/__tests__/integration/eventor-reentry.test.ts:16-32` and `eventor-import-cardless.test.ts:20-36` mock the `fetch*` functions wholesale.
  - `eventor-upload.test.ts:82-152` uses one runner with no splits, fees or place.
  - `e2e/eventor-stub.mjs:86-96` serves only `organisation/apiKey` and `events`.
  - `pushResults` and `pushStartList` (`routers/eventor.ts:1526`, `:1798`) are called by no test, and there are no recorded Eventor XML fixtures.
- **What is wrong:**
  - Nothing tests the XML-to-object mapping in `fetchEntries`, `fetchResults`, `fetchEventClasses` (beyond `parseEventorStartListCourseLengths`), `fetchCompetitors` or `fetchCachedCompetitors`.
  - Nothing tests the router glue that turns DB rows into upload rows (`routers/eventor.ts:1680-1773`): status mapping, fees, splits and ZeroTime conversion.
  - RES-02, RES-21, EVT-04, EVT-10 and EVT-19 all sit in this untested band.
- **Fix (M):**
  - Add anonymised XML fixtures: entries with fees, two CCards, two EntryClasses, no card; results with every status.
  - Unit-test the parsers through a stubbed `fetch`.
  - Add an integration test that seeds an event (zero time not 00:00; OK, MP and DNS runners; a no-timing class; a tie) and asserts the unzipped XML of both pushes, against the IOF 3.0 XSD if it can be vendored.
- **Confirmed** by grep.

---

## Low

### EVT-22 (PR #254) Course length and climb in the uploads: no defect found, but untested against Eventor and with no off switch
- **Area / category:** Eventor upload (PR #254); functional risk.
- **Location (PR branch):**
  - `packages/api/src/eventor.ts:210-225` (`iofClassCourse`), spread at `:1446` and `:1589`.
  - `postZip` at `:1371-1390`.
  - `packages/api/src/routers/eventor.ts:1759` and `:1854` (`classCourseForUpload`, always called).
  - Inputs at `:1528` and `:1803` are `{ dryRun }` only.
- **What is wrong:** the element order matches IOF 3.0, and the feature has unit and integration tests. The round trip is documented in `docs/course-elevation.md` §8. The `Course` element is sent for every class whose course has a length *or* a climb, which is nearly every event. The upload is all-or-nothing and has no switch to leave the element out. The spec (§0.38) says only that Eventor's handling of the climb is unknown. Outright rejection is unlikely for schema-valid XML, but it was not tested. By design, a push made before any sync replaces the organiser's published course length in Eventor.
- **Fix (S):** before merging, push once to Test-Eventor and record the result in §0.38, or add `includeCourse: false` as an input so the organiser can retry without it.
- **Plausible.** The code is proven. Eventor's behaviour was not checked.

### EVT-23 Push and sync act on one click, with no confirmation
- **Area / category:** Eventor UI; UX safety.
- **Location:** `packages/web/src/pages/EventPage.tsx:398-457` (handlers at `:399`, `:419` and `:439`; mutations at `:352-356`). Env comes from `event.eventorEnv || "prod"` (`routers/eventor.ts:1549`, `:1818`).
- **What is wrong:**
  - "Sync from Eventor", "Push start list" and "Push results" fire immediately.
  - A push to a prod-linked event goes to production Eventor, and a sync overwrites and cancels runners (EVT-01, EVT-02, RES-02).
  - The client never uses the `dryRun` input.
  - There is an amber "test" badge for Test-Eventor events, but no marker for production.
- **Fix (S):** add a confirmation dialog that names the target (production or Test-Eventor, and the event number). For a push, show the `dryRun` count and any skipped classes (EVT-14). This is the cheap mitigation for EVT-01 and EVT-02 until they are fixed.
- **Confirmed** from code.

### EVT-24 LiveResults radio splits count the Nth stored punch as the Nth visit, so duplicate punches shift visits
- **Area / category:** LiveResults; functional (unusual case).
- **Location:**
  - `packages/api/src/liveresults.ts:130-145` (`encodedRadioPunches`) and `:475-484`: the query does not filter on `source` or `isOriginal`.
  - Duplicate writers:
    - `online-input/puller.ts:258`
    - `routers/control.ts:1881`: `skipDuplicates` is a no-op, because the only dedup index, `punches_oi_dedup_idx` (init migration `:542-543`), covers `online_input` only.
    - `routers/control.ts:1780-1797` (`pushBackupPunch`): inserts a `manual` mirror and leaves the original live.
- **What is wrong:** visits are numbered by counting rows per control code, with no dedup by time or source.
- **Scenario:** on a butterfly course, radio control 82 is visited twice. The backup memory is imported after ROC has delivered, or a backup punch is pushed. A runner who has passed once gets a second-visit split equal to the first.
- **Fix (S):** before counting, collapse punches of the same code within a few seconds of each other, preferring sources in a set order. Exact-key dedup like `punchDedupeKey` is not enough. Unit-test with a duplicate pair.
- **Confirmed** from code.

### EVT-25 The fee details the UI promises are never sent
- **Area / category:** Eventor upload; functional and docs.
- **Location:**
  - `packages/api/src/eventor.ts:1258-1287` (`buildAssignedFee`), with `taxable` and `isLateFee` declared at `:164-165`.
  - `packages/api/src/routers/eventor.ts:1742-1772`: fee fields at `:1758-1766`, and neither is set.
  - Help text: `en/event.json:144` and `sv/event.json:144`, rendered at `EventPage.tsx:305`.
- **What is wrong:** every fee is sent as `type="Normal"` with no `TaxableAmount`, although `runners.taxable_cents` is imported and already loaded. No late-fee derivation exists, despite the comment at `:165`. A runner with only a taxable amount gets no `AssignedFee` at all (`:1268`).
- **Fix (S):** set `taxable: r.taxableCents || undefined`. Either derive late fees from `Class.classFeeCents`/`highClassFeeCents`, or remove "Normal/Late type" from both help strings. Add a fee case to `eventor-upload.test.ts`.
- **Confirmed** from code.

### EVT-26 Eventor API keys are stored in plain text
- **Area / category:** key store; security.
- **Location:**
  - `packages/api/src/eventorKeyStore.ts:53-56` and `:100-102`.
  - `packages/api/src/db.ts:136-154`.
  - The table is `oxygen.settings` (`schema.prisma:244-250`).
  - `docs/ops/backup-restore.md:20` recommends a full `pg_dump --schema=oxygen`.
- **What is wrong:** the keys are clear text in the DB and in every full dump. No endpoint, log or per-event backup leaks them; that part is clean. Copying the `secret-box` pattern from `map-store/dem-settings.ts` would not help against a dump, because that pattern stores its sealing key in the same table (`docs/map-terrain.md:1734-1738`).
- **Fix (M):** seal the keys with a key held outside the DB (an env var or a file). That is a deploy change. Migrate legacy values on read. Update the other readers: `e2e/global-setup.ts`, `scripts/eventor-pace.ts`, `packages/api/scripts/migrate-mysql-to-pg.ts` and two integration tests. If you accept the risk, document it instead.
- **Confirmed** from code. The fix is narrowed from S to M.

### EVT-27 Dead or misleading Eventor endpoints and helpers
- **Area / category:** Eventor; engineering.
- **Location:**
  - `packages/api/src/routers/eventor.ts:570-578` (`setEventEnv`): no caller. A direct call by a manager repoints the event to the other environment but keeps the numeric `eventorEventId`, so sync and push would address an unrelated event with the same id.
  - `:558-568` (`setKey`): duplicates `validateKey`. Only a permission test calls it.
  - `:1864-1877` (`importEntries`): always throws, and its docstring is false.
  - `:535-549` (`keyStatus`): returns `valid: true` without validating.
  - `packages/api/src/eventor.ts:867-896` (`fetchReferencedClubs`): no request; it rebuilds the caller's map. The caller's try/catch at `routers/eventor.ts:436-441` is dead.
  - `routers/eventor.ts:480`: `void env`.
  - `eventor.ts:1205-1229` (`fetchClubLogo`): always calls production Eventor with the event's key, including a Test-Eventor key, so test logos fail silently.
- **Fix (S):** delete `setEventEnv`, `setKey`, `importEntries` and `fetchReferencedClubs`. Pick the logo host from the key's env.
- **Confirmed** from code.

### EVT-28 IOF CourseData export lists deleted classes in `ClassCourseAssignment`
- **Area / category:** IOF XML export; functional.
- **Location:** `packages/api/src/course-export.ts:239-243` has no `removed: false`. Class delete keeps `courseId` (`routers/classRouter.ts:446-457`).
- **What is wrong:** soft-deleted classes are exported as assigned to their old course. They show up in Condes and other importers, and in Oxygen's own re-import preview. The Purple Pen export does not emit classes and is unaffected.
- **Fix (S):** add `removed: false` to the `where`, and add a case to `course-export.test.ts`.
- **Confirmed** from code, narrowed to the IOF export only.

### EVT-29 The `external` router is unused, and its header promises unauthenticated access it does not give
- **Area / category:** external read API; dead code, misleading comment.
- **Location:** `packages/api/src/routers/external.ts:1-6` (comment) and `:13`, `:25`, `:35` (`viewProcedure`). Registered at `routers/index.ts:58`.
- **What is wrong:**
  - There are no callers and no tests.
  - The comment says kiosk clients that "may not authenticate" use it, but with auth on a kiosk key gets UNAUTHORIZED.
  - `startList` returns `cardNo` and cancelled/DNS runners. That would matter if someone "fixed" the auth as the comment suggests.
  - Every query is scoped to `ctx.event.id`.
- **Fix (S):** delete the router. If kiosks really need it, correct the comment and move it to `kioskOrViewProcedure` after dropping `cardNo` and filtering withdrawn runners.
- **Confirmed** from code.

---

## Not reviewed / could not verify

- **Eventor's real behaviour.** No network access. This is the open question behind EVT-14 and EVT-22, the share of entries with repeated `CCard`/`EntryClass` (EVT-10), whether Test-Eventor shares person ids with prod (EVT-15), and the multi-day `RaceResult` shape of `results/event`.
- **Other external systems.** LiveResults' public site behaviour under double pushes (EVT-06) and whether real Purple Pen opens the fixed export (EVT-07) were not tried.
- **Nothing in the repo was run.** node_modules was not installed. The reproductions were throwaway scripts against fast-xml-parser 5.12.1, and the mysql2 3.24.6 source was read, not run.
- **Not read:**
  - `routers/registrationTrends.ts` and `clubRouter.ts`, beyond their Eventor call sites.
  - `scripts/eventor-pace.ts`, `scripts/migrate-mysql-to-pg.ts` and `e2e/eventor.spec.ts`, beyond test titles.
  - Swedish strings, except where a verifier checked them.
- **Not traced:**
  - The `.ppen` side of EVT-17.
  - Whether the `startName` ambiguity in EVT-17 reaches the editor and print paths.
  - Whether EVT-08 can trip the card unique index on journal apply.
  - The ROC puller's version of EVT-06.
- **Left to other areas:** course geometry, alignment and OCAD import (area 9), PDFs and `backup.ts` downloads.
- **Dependencies:** fast-xml-parser 5.12.1, adm-zip and mysql2 were not checked against a vulnerability database (area 11).

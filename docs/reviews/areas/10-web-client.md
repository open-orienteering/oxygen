# Area 10: Web client (state, race-day screens, registration and performance)

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Reviewed on `main` at `df5460c3`. Review only: no code was changed.

**Scope:** the web client in `packages/web/src` outside the parts other areas own. That is the app shell and data layer (`App.tsx`, `main.tsx`, the tRPC client and query client, `CompetitionShell`, `CompetitionSelector` minus Eventor, contexts, hooks, auth and permission UI, error boundary, update and reload flows, i18n); registration and the runner, card and club pages with structured search; classes, controls, event settings, the club library tabs and registration trends; the race-day screens (kiosk, finish and start stations, start screen, Card Readout, Backup Punches, punch table, card notification); results, start lists, the dashboard and the draw timeline; and a cross-cutting performance pass at 2,000 runners (polling, invalidation, payloads, list rendering, bundle and compression). Left to other areas: card protocol and readout pipeline (05), offline queue internals (06), results, ZeroTime and draw logic (04), Eventor UI (07), map renderer and editor (08), course editor, printing and elevation including the PR 254 web changes (09), build and test infrastructure (11). PR 254 touches this area only with one line in `EventPage.tsx`, which was checked and is fine.

**Method:** five Fable reviewers each read one chunk in full: A shell and data layer, B registration, runners, cards, clubs and search, C classes, controls, event settings, library and trends, D race-day screens, E results, start lists, dashboard plus the cross-cutting performance pass. That gave 85 raw findings. 48 fresh Fable verifiers, given only the locations and claims and never the reviewer's reasoning, were told to disprove them: one verifier per high claim, medium claims in pairs and low claims in groups of five, each judged on its own. `node_modules` was installed this time, so where it was cheap reviewers and verifiers ran scratch vitests or Node reproductions against the real code and the installed TanStack Query (for example the cache behaviour behind WEB-01, the search parser in WEB-65 and the trends merge in WEB-68); each Verdict says what was run, and every scratch file was deleted. One `vite build` into the scratchpad measured chunk sizes (WEB-76). There is no DOM test environment in `packages/web`, and no browser, E2E or integration run was done, so UI behaviour is from code reading.

**Result:** no claim was refuted outright, but 26 were narrowed by their verifier, and each section states only what survived. Severity moved for eight claims: down for WEB-32 (event settings seeded from stale cache, high to medium since it needs a switch plus a blur), WEB-41 (time edit clears the time, high to medium since the row then shows a dash), WEB-64, WEB-70, WEB-72 and WEB-73 (medium to low), WEB-68 (medium to low: sub-second stall, wrong value cosmetic on a secondary page); up for WEB-40 (class max time `2:30` read as 2 min 30 s marks the whole class OverMaxTime, low to medium). Duplicates were merged: the unscoped query cache (reviewers A1 and E1, now WEB-01), the change poll (A5 and E2, WEB-14), the single error boundary (A6, E6 and D7, WEB-15) and the start-screen poll (D10 and E8, WEB-47). One claim was dropped as a duplicate of another area: the results class order (E4) is CRS-064; its verifier adds that `ResultEntry.classId` already carries the class seq, so CRS-064 can be fixed client-side, contrary to the CRS-064 verifier note. That leaves 79 findings.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 12 |
| Medium | 47 |
| Low | 20 |

No finding reached critical on its own: each data-corrupting path here needs a second condition (a competition switch on a slow link, a card read twice within 24 h). Several high findings feed the same root cause as SYNC-19, so fixing them together matters more than any one rating.

**Fix first:**
1. **WEB-01 together with SYNC-19 and WEB-02:** the query cache has no competition in its keys and a switch only invalidates it, so stage 2 shows stage 1's runners (per-event seq ids) and an edit or bulk action on them changes a different runner in stage 2. The kiosk's version of the same bug (WEB-02) prints the wrong receipt for a returning card and can write a finish onto an unrelated runner. One fix (per-competition keys or client) closes all three.
2. **WEB-03 and WEB-04:** with the server unreachable while the browser thinks it is online, the shell will not open a cached competition, and a failed background refetch of `users.me` blanks the app and reloads the page in a loop, also with auth off. Together they take a station down for the whole outage although its data is cached.
3. **WEB-05, WEB-06 and WEB-11:** registration writes wrong data: owner data from an earlier card fills the next runner's name, "No club" is saved as the first free-text club, and clubs without a runner in the event cannot be picked at all.
4. **WEB-07 and WEB-08:** the runner editor drops all but the last field edited within 600 ms behind a green "Saved", and failed saves (a taken hire card, an empty name) show nothing, so the operator believes a card change took effect when it did not.
5. **WEB-09:** the class course picker shows a forked class but saves only the first course, and each tick rewrites the class course at once with no confirmation, mid-event included.

Quick wins (S each): WEB-06, WEB-10 and WEB-12 among the highs; WEB-13 (persister `maxAge` contradicts `gcTime: Infinity`), WEB-40 and WEB-41 (time inputs parsed without validation), WEB-53 (Enter overwrites an existing finish) and WEB-59 (no compression on the cloud image). A shared global `MutationCache` `onError` toast would close the silent-failure part of WEB-08, WEB-25, WEB-34, WEB-38, WEB-50 and WEB-69 in one change; the per-page error states (WEB-30, WEB-39, WEB-56) need a shared list error component.

---

## High

### WEB-01 The query cache is neither keyed nor cleared by competition: after a switch, competition B shows A's cached rows (with A's per-event ids), and edits on them hit other runners in B
- **Area / category:** app shell, state and data layer; functional (data integrity).
- **Location:**
  - `packages/web/src/pages/CompetitionShell.tsx:229-261` (resets `:239-245`, `utils.invalidate()` `:246`, offline branch `:249-253`), `:203-210`, `:145-153`, `:266-287` (`dashboardRef`), `:379` (ready gate).
  - `packages/web/src/main.tsx:19-27`, `:51-65`, `:75-87`; `packages/web/src/lib/trpc.ts:8`, `:22-31`; `packages/web/src/lib/offline/persister.ts:4`.
  - `packages/web/src/pages/RunnerManagement.tsx:44`, `:199-208`, `:257-262`; `ResultsPage.tsx:33-37`; `StartListPage.tsx:31-33`; `CompetitionDashboard.tsx:14`; `KioskPage.tsx:104-122`; `FinishStation.tsx:49-63`; `hooks/useStationSync.ts:44-63`; `App.tsx:95-97`.
  - `packages/api/src/routers/runner.ts:13-40`, `:641-660`; `packages/api/src/routers/lists.ts:56`, `:202`.
- **What is wrong:** event-scoped queries have `undefined` or `{}` input, so their React Query keys are the same for every competition. The competition travels only in the `x-competition-id` header, read from `window.location` at send time, and there is one QueryClient and one IndexedDB key. On an online switch the shell resets five map and course queries and calls `utils.invalidate()`, which keeps the data of inactive queries. (a) B's pages mount and get A's rows at once with `isLoading=false`; they show for the whole refetch and stay if it fails. (b) `createTRPCReact()` has no `abortOnUnmount`, so a request for A still in flight is joined by B's observer and its answer is stored as fresh for 30 s (shell) or 60 s (`useStationSync`, `FinishStation` receipt name and date). Runner ids are per-event `seq`, and `bulkUpdate` resolves them under the header's event, so an edit on a stale row changes a different runner in B. The offline branch and the kiosk and start-screen routes do not even invalidate.
- **Scenario:** stage 1 and stage 2 are separate competitions. The operator leaves stage 1's Runners page and opens stage 2 on slow arena Wi-Fi. The table shows stage 1's 2,000 runners under stage 2. The operator bulk-changes status or edits runner 412 (stage 1's Anna); the mutation goes with header `stage2` and changes stage 2's runner 412. A stage 1 dashboard poll in flight across the switch gives stage 2 wrong tab counts and receipt headers for 30 s.
- **Fix (M):**
  - Preferred: put `nameId` into every event-scoped key, or use one QueryClient and persister key per competition, with the providers moved below `BrowserRouter`, the same client in the kiosk, start-screen and `DeviceManager` paths, and paused mutations kept with their event.
  - Minimum: on a `nameId` change, before `ready`, `cancelQueries()` then `removeQueries` for event-scoped keys (`resetQueries` for active ones), never `queryClient.clear()`, which drops paused offline mutations; persist the owning `nameId` as a marker. This wipes A's offline fallback.
  - List pages should show an error state and disable bulk actions while `isError` after a switch (see WEB-56).
  - Tests: two `nameId`s never share a cache entry; E2E where B's `runner.list` is aborted and A's rows must not show; one where A's response is delayed past the switch.
- **Verdict:** confirmed by code reading and scratch vitests against React Query 5.107: an invalidated entry is served to a new observer with `isLoading=false` and survives a failed refetch; an in-flight fetch is joined and stored with `isStale=false`. Dropped: A's capabilities gating B (`myCapabilities` is refetched before `ready`) and a lasting lease badge (it refetches on mount). "Indefinitely" narrowed to "until a refetch succeeds". Category changed from security, since the API still scopes by header. High stands. SYNC-19 has the same root cause on the offline path only; related SI-16, BLD-24, SYNC-25. (reviewer A1; also E1)

### WEB-02 Kiosk readout screen prints and records a finish from cached data of an earlier read of the same card number
- **Area / category:** race-day screens; functional.
- **Location:**
  - `packages/web/src/pages/KioskPage.tsx:725-728`, `:733-755`, `:758-766`, `:788-803`, `:349-354`, `:475`.
  - `packages/web/src/main.tsx:19-27`, `:76-87`; `packages/web/src/lib/offline/persister.ts:4`.
  - `packages/web/src/pages/CompetitionShell.tsx:275-280`.
  - `packages/api/src/routers/race.ts:334-350`.
- **What is wrong:** `ReadoutScreen` keys `runner.findByCard` and `cardReadout.readout` only by card number, and `race.finishReceipt` by the runner id the first query returns. Defaults are `staleTime` 5 s and `gcTime` 24 h, and the whole cache is persisted under one IndexedDB key with no competition. On mount React Query returns the cached rows at once and refetches in the background. The print effect sets `printedRef` and calls `onPrint` with the cached runner id; the admin tab fetches `finishReceipt` for that seq in the current competition and prints it. The right runner then gets no receipt. The finish effect sends `recordFinish` with the cached id when the cached row has `finishTime` 0, and the server writes it on that seq with no card check. Snapshot growth is already SYNC-28.
- **Scenario:** a two-day event, each day its own competition, on the same laptop. Runner X had seq 17 on day 1 and reads card 8001234 again at `/day2/kiosk`. The cache answers with id 17, so the receipt of whoever is seq 17 on day 2 prints, and X gets none. This repeats for every returning kiosk user. If X had no finish punch on day 1 (DNF), `recordFinish({runnerId: 17})` writes a finish time on an unrelated day-2 runner. A card number moved to another runner within 24 h does the same in one competition.
- **Fix (S-M):**
  - Guard both effects with `isFetchedAfterMount` (`dbRunner` for the finish, `receipt` for print) and print with the fresh id. State and test that the kiosk then no longer auto-prints or records from cache when offline.
  - Exclude the three per-card keys from the persisted snapshot with `shouldDehydrateQuery` or a meta flag; `gcTime: 0` alone does not, because restored queries get the default 24 h.
  - Test: extract the two effects into a hook and test it with a seeded QueryClient holding another runner id; the package has no jsdom or testing-library for a component test.
- **Verdict:** confirmed by code reading and a scratch vitest: a `findByCard` result seeded 17 h earlier, dehydrated and rehydrated, is returned first with `isFetchedAfterMount=false`, then replaced by the fresh row. `ReadoutScreen` itself was not mounted. Narrowed: the cross-day case needs the day-1 entries in the kiosk tab's cache, either a tab left open or a snapshot last written by the kiosk tab (likely, as it writes about every second) and under 24 h old. The wrong finish write is the rare part, since in paired mode `DeviceManager` applies the result first. High stands. API-13 (no card binding on `recordFinish`) would also stop the wrong write; related SYNC-19, SYNC-28, SI-32. (reviewer D1)

### WEB-03 The shell opens a competition from cache only in a page loaded while offline; with the server unreachable, after an `offline` event, or on other errors it spins or dead-ends
- **Area / category:** app shell, state and data layer; stability.
- **Location:**
  - `packages/web/src/pages/CompetitionShell.tsx:140-155`, `:177-199`, `:229-261`, `:353-377`, `:379-401`.
  - `packages/web/src/main.tsx:19-27`.
  - `packages/web/src/lib/session-recovery.ts:18-19`, `:53-72`.
  - `docs/guide/platform.md:44-51`.
- **What is wrong:** `ready` is set only by `competition.select`: in `onSuccess` (`:143`), or in `onError` (`:151`) when `!navigator.onLine` and a cached dashboard exists. (1) Server unreachable while the browser is online: the effect retries once after 600 ms and calls `attemptSessionReload()`; the sessionStorage guard survives the reload and the second pass stops on "Reconnecting session..." with no cache fallback. Nothing retries when the link returns except a visibility change or a button press. (2) After the browser fires `offline`, mutations (default `networkMode: 'online'`) are paused, so `select` never errors and "Loading competition..." stays until the network returns; the comment at `:251-252` is wrong. (3) Any error that is not network-class or NOT_FOUND, such as a 502/504 or `INTERNAL_SERVER_ERROR`, ends on the "Connection error" page whose only action is "Back to competition list". Also, `select` callbacks are not tied to their `nameId`, so a late `onSuccess` for A sets `ready` under B's URL and can hide B's error.
- **Scenario:** a finish operator loses network mid-event, presses back by mistake and re-opens the competition from the cached list: the spinner never ends, although `runner.list`, the dashboard and the outbox are on the device. Or the station reloads while the server laptop is unreachable over still-connected Wi-Fi and stays on "Reconnecting session...".
- **Fix (M):**
  - On mount, if a cached dashboard for this `nameId` exists, set name and `ready` from it and run `select` in the background with `networkMode: 'always'` (as SYNC-25 proposes). NOT_FOUND shows the not-found page; other failures keep cached mode with the offline indicator and retry on `online`, an interval or visibility. This needs WEB-01's per-competition cache, or it shows the previous event.
  - Without cache, show a Retry button with backoff for every non-NOT_FOUND failure.
  - Drop the `!navigator.onLine` conditions at `:147` and `:179`, ignore callbacks with a stale `variables.nameId`, and fix the comment.
  - E2E: go offline inside an event, return to `/`, re-enter; abort `select` with `onLine` true and a warm cache; `select` answering 502.
- **Verdict:** confirmed by code reading of the shell and query-core 5.107.1, and a scratch vitest: with `onlineManager.setOnline(false)` the mutation stays paused with no `onError`; a superseded mutation's `onSuccess` still fires; the 502 HTML message is not network-class. Corrected: the bundled nginx answers 502/504 as JSON, so the cited `html-api-response.ts` path applies only behind other proxies, though the outcome holds; awaiting `utils.invalidate()` is minor. Gap 1 is worse than claimed: nothing retries after the guard blocks, and fetches slower than about 7 s loop the reload. High stands: no data is lost, but a reload or re-entry during an outage takes the station down, contrary to `docs/guide/platform.md`. Shares a root cause with SYNC-25. (reviewer A3)

### WEB-04 A failed background refetch of `users.me` replaces the whole app with a spinner and then reloads the page, also when auth is off
- **Area / category:** app shell, state and data layer; stability.
- **Location:**
  - `packages/web/src/context/CurrentUserContext.tsx:25-26`, `:33-49`, `:56-59`.
  - `packages/web/src/App.tsx:54-58`, `:105`.
  - `packages/web/src/components/KioskAccessGate.tsx:17-24`.
  - `packages/web/src/lib/session-recovery.ts:19`, `:54-73`, `:84-97`.
  - `packages/web/src/pages/CompetitionShell.tsx:247`, `:258`.
  - `packages/web/src/hooks/useEventQueue.ts:92`.
  - `packages/web/vite.config.ts:65-70`.
- **What is wrong:** `networkClass = me.isError && isNetworkClassError(me.error)` is also true when a refetch fails while good data is cached. Then `isLoading` is true, and with auth on `App.tsx` renders `<PageSpinner/>` instead of `<Routes>`: the shell, the open station page and the registration dialog unmount, and the shell cleanup sets `DeviceManager`'s competition to null. `KioskAccessGate` blanks the kiosk the same way. Regardless of `authEnabled`, the effect at `:33-45` refetches after 600 ms and on a second failure calls `window.location.reload()`. The code was written for an expired IAP cookie but cannot tell that from a dropped request. After the reload it is worse: the errored `users.me` is not persisted, `authEnabled` defaults to true under `networkClass`, so an auth-off station also sits on the spinner, and nothing retries until a visibility change, an `online` event or a manual reload.
- **Scenario:** the arena uplink drops for 30 s while `navigator.onLine` stays true. The operator presses the manual drain button, or the tab becomes visible again: `users.me` fails twice. With auth on, the station turns into a spinner for about 1.6 s and reloads; with auth off, it just reloads. The half-filled registration is lost, and after the reload the shell cannot open the competition (WEB-03). The reload repeats only when a failure cycle takes longer than the 15 s guard.
- **Fix (S-M):**
  - Use `isLoading: me.isLoading || (networkClass && !me.data)`.
  - Do not auto-reload when `me.data` exists; confirm IAP expiry with a probe that bypasses the service worker (`/api/version` is itself NetworkFirst-cached) or show a "sign in again" banner. The probe or banner is required, as long-open tabs always have cached data.
  - For the cold start, persist the last known `authEnabled`, retry periodically in the error state and reset `recoveryStarted`.
  - Test: extract the decision into a pure function and test that a cached success plus a failing refetch keeps children mounted and does not reload (no jsdom in the package today).
- **Verdict:** confirmed by code reading and a scratch vitest against React Query 5 and tRPC client 11: a cached `users.me` whose refetch throws "Failed to fetch" ends with `isError=true`, data kept and `networkClass` true. The unmount is from reading `App.tsx`. Corrected: TanStack v5 refetches on `visibilitychange`, not window focus, so alt-tab triggers it only if the window was hidden; manual drain and shell mount are the reliable triggers. The proposed `authEnabled` change is equivalent to the current code and is dropped. The 15 s constant is at `session-recovery.ts:19`. High stands: the outbox survives, but an ordinary drop takes the station down. Related SYNC-03, SYNC-16. (reviewer A2)

### WEB-05 Registration dialog: owner data from an earlier card fills the name for the next card
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:72`, `:173-191`, `:295`, `:362-378`, `:394-398`, `:436-458`, `:751-760`, `:975`.
  - `packages/web/src/context/DeviceManager.tsx:337`.
  - `packages/web/src/lib/si-protocol.ts:918`.
- **What is wrong:** `pendingOwnerDataRef` holds the SI card's owner data for the deferred name fill. It is written at `:295` (pending-card path, correctly `?? null`) and at `:398` (sticky path, only inside `if (latest.ownerData)`). `clearForm`, `startManualCard` and the SI card field never reset it, and the dialog stays mounted, so the ref survives close and reopen. The deferred effect fires for any next card once `findByCard` returns no match and the name is empty. Owner data is null for SI5/6/8/9, pCard and blank SI10 cards, since only the SI10/SIAC/SI11 path parses it. The bug is wider than sticky mode: "New registration" with a typed card number, and ESC-clear in sticky mode, hit it too.
- **Scenario:** at a sticky desk, a personalised SIAC for "Anna Svensson" is registered. The next runner has a hired SI8, or the operator types the number. When the duplicate check returns, the name fills with "Anna Svensson", so the Eventor query (enabled only while `!name`) is skipped. With a local runner dump, the effect order makes the old name win over the dump's name while birth year, sex and club come from the new card. If the operator only picks a class and submits, the second runner is registered under Anna's name.
- **Fix (S):** store the owner data with its card number (`{cardNo, od}`) and apply it only when it matches `cardNoNum`; this also covers edits of the SI card field at `:975`. At minimum, reset the ref in `clearForm`, `startManualCard` and a sticky `else` branch. E2E: extend "sticky submit clears form and next card auto-fills" with an owner-data card followed by an `insertUnregisteredCard` card, and assert the name stays empty.
- **Verdict:** confirmed by code reading only; no harness exists for the dialog. The wider trigger set (manual entry, reopen, ESC) was added by the verifier. A hired SI10 with factory defaults carries an owner-data object and is safe. Enter-to-submit was not checked; the wrong name is visible before submit, which is the only mitigation. High stands: mixing personalised and hired cards is normal, and the result is a runner under another person's name. Not reported elsewhere. (reviewer B6)

### WEB-06 Registration with "No club" is saved under the first free-text club when the event has any club without an Eventor id
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:49`, `:92`, `:144`, `:621-622`, `:645`, `:888-895`.
  - `packages/web/src/components/SearchableSelect.tsx:56`, `:188`.
  - `packages/api/src/routers/clubRouter.ts:70-77`, `:80`.
  - `packages/api/src/routers/runner.ts:432-433`.
- **What is wrong:** `club.list` returns every club without an Eventor id as `id: 0, extId: 0`, sorted by name. The dialog's default `clubId` is 0 and `selectedClub = clubs.data?.find((c) => c.id === clubId)` has no `clubId > 0` guard, so it resolves to the alphabetically first free-text club. Its name is sent as `clubName` in `runner.create` (with `eventorClubId: 0`), stored verbatim, and shown on the kiosk messages and the receipt. The picker shows "No club" because that option, also value 0, comes first. All free-text options share value and React key 0, so picking any of them saves the first one. `fuzzyMatchClub` matching a free-text club does the same. The offline path sends `clubId: 0`, which the server maps to no club, so the same form stores different clubs online and offline.
- **Scenario:** one runner was imported with the typed club "Friskis" and no Eventor id. From then on every online registration left on "No club" is stored as "Friskis", which reaches results and club invoicing, while the operator sees "No club".
- **Fix (S):** give options unique values (`e:<eventorId>`, `n:<name>`) with "No club" as its own sentinel, derive `clubName` and `eventorClubId` from the chosen option, and update the `setClubId(match.id)` call sites (`:306`, `:339`, `:357`, `:407`, `:566`) and the offline payload. The one-line `clubId > 0` guard fixes "No club" but leaves free-text clubs unselectable. Add a unit test for the option mapping.
- **Verdict:** confirmed by code reading of `club.list`, the dialog, `SearchableSelect` and `runner.create`; no test was run. The fuzzy-match and offline mismatch effects were added by the verifier. The API range is narrowed to `clubRouter.ts:70-77`. High stands: wrong club data is stored silently, though nothing is lost. DB-25 has the same root cause on `club.detail` and the clubs page; a name-keyed id from the API would fix both. (reviewer B4)

### WEB-07 Runner inline editor: one debounce timer for all fields drops the earlier edit behind a false "Saved", and a late refetch overwrites what is being typed
- **Area / category:** registration, runners, cards, clubs and search; functional (silent data loss).
- **Location:**
  - `packages/web/src/components/RunnerInlineDetail.tsx:73-96` (single `saveTimeoutRef`, cleared at `:80`, payload `{ [field]: value }` at `:84`, `onError` at `:90`).
  - `packages/web/src/components/RunnerInlineDetail.tsx:136-242` (every field goes through `debouncedSave`, plus `SelectField` and `SelectClubField`).
  - `packages/web/src/components/RunnerInlineDetail.tsx:375-385` (`EditField` copies a changed `value` prop into `localValue`).
  - `packages/api/src/routers/runner.ts:524` (`runner.update` writes only the fields it is sent).
- **What is wrong:**
  1. **Dropped edit.** The panel has one timer. Each `debouncedSave` call clears it, and the surviving call sends only its own field. An edit to field A followed within 600 ms by an edit to field B never sends A. The indicator shows Saving then Saved, because the callbacks belong to B's call. Field A's input keeps showing the unsaved text next to "Saved" until the row is collapsed and reopened, so the operator has no cue at all that the edit was lost.
  2. **Refetch overwrites typing.** Every successful save invalidates `runner.getById`, and `EditField` copies any changed `value` into `localValue` unconditionally. If typing resumes inside the save-and-refetch round trip, the response for the earlier prefix replaces the newer text. For fields whose display is a normalised form of the input (start and finish time via `formatMeosTime`, card number via `parseInt(...) || 0`) this is deterministic: any 600 ms pause saves the partial value and the refetch rewrites the input, so "10:4" becomes "00:10:04".
- **Scenario:** the operator corrects a runner's name, tabs to the card field and types the new card number within 600 ms. Only the card number is saved. The name input still shows the corrected name and the panel says "Saved", but the database has the old name.
- **Fix (S-M):**
  - Collect pending changes in one map with one timer (`pending = { ...pending, [field]: value }`, send `data: pending`), or use one timer per field.
  - In `EditField`, do not sync from props while the input is focused or dirty; clear the dirty flag when the stored value equals the local one.
  - Better still, commit on blur or Enter as RES-13 proposes for time fields; fix the two together.
  - Surface save errors (see WEB-08).
  - Tests: a component or E2E test that edits two fields within 600 ms and asserts both are stored after reload; one that types into a time field with a pause and asserts the input is not rewritten mid-typing.
- **Verdict:** confirmed in part, from code reading of the component and `runner.update`; no test was run, as the component has no unit test. Refuted and dropped: the claim that the name field reverts to the old value after the refetch. The refetch returns the unchanged server value, so the effect does not fire and the stale text stays, which is worse because nothing signals the loss. The normalised-field variant of part 2 was added by the verifier. Not a duplicate of RES-13, which covers half-typed time values saved by the same debounce. Overlaps WEB-08 (silent errors in the same component). Severity stays high: a fast tab from name to card number is normal desk use. (reviewer B1)

### WEB-08 Runner inline editor: failed saves are silent, so a rejected card number or empty name stays in the input with no message
- **Area / category:** registration, runners, cards, clubs and search; stability.
- **Location:**
  - `packages/web/src/components/RunnerInlineDetail.tsx:74-96` (`onError: () => setSaving(false)` at `:90`) and `:129` (stale "Saved").
  - `packages/web/src/components/RunnerInlineDetail.tsx:53-71`, `:151`, `:164-169`, `:278`, `:318-345` (mutations without `onError`).
  - `packages/web/src/components/RunnerInlineDetail.tsx:375-385` (`EditField` local state) and `:466-477` (class select with the '-' option).
  - `packages/web/src/main.tsx:19-27` (no global mutation error handler).
  - `packages/api/src/routers/runner.ts:45-58`, `:100-101` (`classSeqToId`), `:146-168` (`assertCardNotTaken`), `:194-207` (schema), `:529-533`.
- **What is wrong:** the only error handling on the main save is clearing the spinner. `updateMutation.error` is never rendered, and the `QueryClient` has no `MutationCache` handler or toast. `EditField` keeps its `localValue`, and on error nothing invalidates or resets it, so the rejected value stays in the input. The only cue is that green "Saved" does not appear, and line 129 can still show a stale "Saved" from an earlier success for up to 3 s. The server rejects several values this UI sends: a card held by another runner (CONFLICT), an empty name (`min(1)`), class '-' (0, NOT_FOUND) and a malformed two-part time that becomes NaN. Seven call sites have no error handling: `setCardReturned`, add, remove and update punch, the variant select and the two PunchTable start and finish updates.
- **Scenario:** a runner swaps to a hired card and the operator types a number still assigned to another runner. The input shows the new number, no message appears, and the database keeps the old card while the hired card stays on the other runner. At the finish the readout is attributed to that other runner.
- **Fix (S-M):**
  - Render the tRPC error message next to the save indicator, red and kept until the next successful save. If reverting the input, force it with a key or epoch, since a refetch returning the same value does not re-trigger the effect.
  - Add `onError` to all seven other call sites.
  - Validate before sending: non-empty name, class greater than 0, no NaN times; commit `EditField`s on blur or Enter (also fixes WEB-07).
  - Playwright test: set a taken card number inline and expect the CONFLICT text; an empty-name case.
- **Verdict:** confirmed in part, from code reading of the component, `SearchableSelect`, `main.tsx` and `runner.ts`; no test run. Refuted and dropped: a rejected '-' class does not stay on screen, because `SelectField` derives its label from the stored value and snaps back (the same holds for variant, status and sex selects); the stale display applies only to `EditField` inputs. Also dropped: "every edit made while offline looks saved". "Saved" appears only on success; offline, TanStack pauses the mutation and the spinner stays. A one-part malformed time is not rejected but silently cleared, which is RES-13. Line correction: `runner.ts:531-535` is `:529-533`. The shared-timer drop and the refetch overwrite noted by the verifier are WEB-07. API-37k is the same silent-CONFLICT pattern in `CardsPage`. Severity stays high: reassigning to a card still held by someone else is a normal desk action, and it gives a misattributed readout. (reviewer B2)

### WEB-09 Class course picker is a multi-select but only the first ticked course is saved; course changes apply on one click with no confirmation and can clear raced runners' variants
- **Area / category:** classes, controls, event settings, library and trends; functional.
- **Location:**
  - `packages/web/src/pages/ClassesPage.tsx:682`, `:706-709` (`handleCourseChange`), `:906-911` (picker and "Courses (forked)" label), `:1078`, `:1089-1094`, `:1149-1151` (create form), `:580-588` (dead "Forked" badge).
  - `packages/web/src/components/CourseMultiSelectDropdown.tsx:72-78`, `:80-85`.
  - `packages/api/src/routers/classRouter.ts:73-75`, `:143-145`, `:293-343`.
  - `packages/api/src/course-variants.ts:278-290`; `packages/api/src/variants.ts:219-249`.
  - `e2e/classes.spec.ts:177-203`.
  - `packages/web/src/i18n/locales/{en,sv}/classes.json:37-39,56`.
- **What is wrong:** `handleCourseChange(ids)` stores the whole tick list in `editCourseIds` but sends `courseId: ids[0] ?? null`; the create form sends `courseIds[0]`. A class has one course on the server, and `class.detail` and `class.list` return at most one id, so the list badge is dead code. Because the dropdown appends, ticking a second course re-sends the saved one, while the panel shows "2 courses selected", "Courses (forked)" and "Forked, runners will be assigned different courses". `editCourseIds` resets only when the row is collapsed. Each tick or untick calls `class.update` at once, with no check of `runnerCount`. Unticking the only course sends `null`; unticking the first while a second is ticked silently switches to the second. Any `courseId` runs `syncClassPool`; when the new pool is empty, `reconcileClassVariants` clears the variant of every runner in the class, raced runners included, since the RACED guard exists only in `distributeClassVariants`. A re-sent unchanged course still runs `syncClassPool` and journals `class.upserted`.
- **Scenario:** on race morning H21 (120 runners) is on "Bana 1". The operator ticks "Bana 2" without unticking "Bana 1". The UI says forked, the server still has Bana 1, and every H21 readout is evaluated against Bana 1. If the operator unticks Bana 1 first, the class has no course and every runner's variant is cleared.
- **Fix (M):**
  - Replace `CourseMultiSelectDropdown` in both places with a single-select; it has no other callers, so delete it. Drop `editCourseIds`, the dead badge and the strings `courseForked`, `coursesForked`, `coursesSelected`, `forkedDescription` (check `selectCoursesPlaceholder`). The variants panel stays the only fork UI.
  - Skip the mutation when the course is unchanged.
  - For a class with runners, confirm with the runner count and say that variants will be re-dealt.
  - Server guard: clearing a pool must not null raced runners' variants, since `class.bulkUpdate` (`classRouter.ts:390`) takes the same path.
  - Rewrite `e2e/classes.spec.ts:177-203` to assert the stored course after reload; add an integration test that a course change keeps raced runners' variants.
- **Verdict:** confirmed, from code reading of the page, dropdown, router, variant code, E2E and locale files; no test run. The verifier found the variant effect worse than claimed: raced runners lose their variant too, not only unraced ones. Line correction: the picker is `:906-911`. The existing E2E only checks local state and locks in the false UI. Not reported elsewhere; DB-48 touches the same files but is unrelated. Severity stays high: ticking the new course without unticking the old is the natural checkbox gesture. (reviewer C2)

### WEB-10 Bulk "Set club" changes only the Eventor id; the club name shown in lists stays the old one, and a free-text club strips the id
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/pages/RunnerManagement.tsx:194-208` (`handleApplyBulk`), `:457-468` (club select), `:320-321` (row renders `ClubLogo` by id and `clubName` as text).
  - `packages/api/src/routers/runner.ts:641-715` (`bulkUpdate`, club fields at `:669-676`) and `:85-98` (single-runner path).
  - `packages/api/src/routers/event.ts:593-622` (`competition.clubs`, `id: 0` at `:616`).
- **What is wrong:** the bulk bar sends `{ ids, eventorClubId: Number(bulkValue) }`. `bulkUpdate` sets `clubName` only when a `clubName` input is given, which the client never sends, and does no directory lookup. `runner.list` returns `clubName` as stored, so after the action the logo follows the new id while the name stays. The same name-less patch is journaled, so peers replay the inconsistency. The single-runner `clubId` path does look up the name, so the two paths disagree. Free-text clubs all get `id: 0`: every such option has value "0" and React key 0, the confirm text names the first id-0 club whatever was chosen, and the write sets `eventorClubId` 0, which code reading `if (r.eventorClubId)` treats as no club id. The result is an Eventor link stripped and the old name kept.
- **Scenario:** select 12 runners entered under the wrong club, choose Set club, "OK Linné", confirm. The confirm names OK Linné, the mutation succeeds, and all 12 rows still show the old club name beside OK Linné's logo.
- **Fix (S):**
  - Client: give options a unique value (`e:<id>` or `n:<name>`) and unique keys, and send `clubName: club.name` with `eventorClubId: club.eventorId ?? null`.
  - Server: when `eventorClubId` is set without `clubName`, resolve the name from `clubDirectory` as `buildRunnerUpdateData` does (best effort); normalise 0 to null; put the resolved name into `journalFields`.
  - Tests: an API integration test for `bulkUpdate` with a club, and a club case in `e2e/runners-bulk.spec.ts` asserting the name column.
- **Verdict:** confirmed, from code reading of the page, `runner.ts` and `event.ts`; no test run, as the path has no branching guard. The verifier found the free-text part slightly worse (shared value and key, wrong confirm label). Not verified: which results and invoices group by name and which by id, so that part of the original scenario is dropped. Corrected locations as above. The `bulkUpdate` transaction timeout (DB-39) is a different defect in the same procedure; DB-25 covers free-text clubs getting id 0. Severity stays high: the feature fails on every use, though it is an occasional action and repairable per runner. (reviewer B3)

### WEB-11 On-site registration can only pick clubs that already have a runner in the event, and "No club" can submit a free-text club
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:86`, `:92`, `:144` (club query and derivation of the submitted club).
  - `packages/web/src/components/RegistrationDialog.tsx:304-307`, `:405-408` (SI owner-data match), `:337-340` (card lookup), `:564-567` (suggestion pick).
  - `packages/web/src/components/RegistrationDialog.tsx:618-622` (online submit), `:639-646` (offline submit), `:882-896` (club picker).
  - `packages/api/src/routers/clubRouter.ts:16-34` (`club.list`), `:69-76` (free-text clubs get `id: 0`), `:222-237` (unused `searchDirectory`).
- **What is wrong:** the dialog asks for `club.list({ showAll: true })`, but the handler never reads its input and builds the list only from the event's non-withdrawn runners; its own doc comment says `showAll` is "currently identical". The picker is a `SearchableSelect` over that list plus "No club", with no free-text input, and `club.searchDirectory` has no web caller. Auto-fill from card lookup, a name suggestion and SI owner data sets the club only when it is already in the list, and silently drops it otherwise. Submit takes `clubName` and `eventorClubId` from the selected roster entry, so another club cannot be sent, although `runner.create` accepts both. The verifier found a second defect in the same lines: free-text clubs share `id: 0` with "No club", so with the default `clubId` 0 `selectedClub` resolves to the first free-text club. Once any runner has a free-text club, every registration left on "No club" is submitted with that club's name, and picking any free-text club resolves to the first.
- **Scenario:** in a direct-entry event the list starts empty. The operator picks "Erik Testsson, OK Ansen" from the suggestions; name, birth year and card fill in, the club stays "No club", and the runner is registered without a club. With payment "Invoice" there is no club to bill.
- **Fix (M):**
  - Keep roster clubs on top and, when the search has no roster match, query `club.searchDirectory` (debounced) and append the results.
  - When a suggestion, card lookup or SI owner-data match carries a club not in the list, keep it as an ad-hoc selected option and submit `eventorClubId` and `clubName` directly.
  - Offline, fall back to the `clubs` map in the cached `runnerDbDump`; this is required, since the directory needs the network. Extend the offline payload, which sends only `clubId`, with `clubName`.
  - Give free-text clubs a distinct key from "No club".
  - Implement `showAll` on the server or remove it.
  - Tests: E2E registration of a runner whose club has no entries; one submitting "No club" while a free-text club exists.
- **Verdict:** confirmed, from code reading of the dialog, `clubRouter.ts` and `runner.ts` and a grep showing no web caller of `searchDirectory`; no test run. The verifier added the id-0 "No club" defect and the second owner-data match at `:405-408`. Not checked: whether the `RunnerInlineDetail` club picker has the same limit. Neighbours: DB-25 (free-text clubs get id 0), DB-43, and the offline-sync note that offline `clubId` is treated as `eventorClubId`. Severity stays high: it hits normal use of direct-entry events, though nothing is lost and the club can be repaired later. (reviewer B5)

### WEB-12 Registration trends: adding a comparison event starts a request storm that never stops if the fetch fails
- **Area / category:** classes, controls, event settings, library and trends; stability.
- **Location:**
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:83-85` (the two `useMutation` hooks).
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:87-152` (`loadComparison`, deps at `:152`; `fetchEntryHistory` at `:116`, second `fetchComparison` at `:119`).
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:155-160` (effect, `void loadComparison(missing)` at `:158`).
- **What is wrong:** `loadComparison` is a `useCallback` whose deps are the mutation result objects, and React Query returns a new object on every render. So the callback changes identity every render and the effect re-runs after every render. Whenever a selected comparison has no entry in `comparisonData`, the effect calls `mutateAsync`, which dispatches "pending", notifies the observer and re-renders, which runs the effect again. The loop ends only when a response is written to `comparisonData`. A rejection writes nothing, so the loop is unbounded, and the rejection is unhandled. Each looped call whose answer reports the event as missing calls `eventor.fetchEntryHistory`, which has no in-flight guard, so each hits Eventor live with the club's API key.
- **Scenario:** the operator adds a comparison event, or opens a `?cmp=` URL, on a slow arena link. The page fires `fetchComparison` once per render tick until the first answer lands, then many of those answers trigger their own Eventor fetch. If the browser is online but the API is down or returns 5xx or FORBIDDEN (the usual case of LAN up, server down), the tab keeps issuing failing requests until it is closed. If the browser reports offline, React Query pauses the mutations instead: no requests go out, but the render loop spins and paused mutations pile up, then all fire on reconnect.
- **Fix (S):**
  - Destructure `mutateAsync` from each hook; it is stable for the observer's lifetime.
  - Stable deps alone are not enough: keep a `requestedRef: Set<number>` so each id is requested once, record failures as `comparisonData[id] = { entries: [], error }`, and add a catch. Clear the ref entry on a forced Refresh (`:403`) and when a comparison is removed.
  - Better: make `fetchComparison` a query keyed by ids. Add a server-side in-flight guard on `eventor.fetchEntryHistory`.
  - Test: an E2E that adds a comparison with the route stubbed slow and asserts exactly one `fetchComparison` request, and one with the route failing.
- **Verdict:** confirmed, from code reading of the page, React Query 5.107.1 and @trpc/react-query 11.28.0 `useMutation`, and the two API procedures, and by a scratch vitest (`packages/web/src/__scratch_v_C_C3__/storm.test.tsx`, deleted) mounting the same hook structure with real React Query and a stubbed `mutationFn`. A 500 ms resolve gave 385 calls and 716 renders for one id, then stopped; a rejecting mutation gave 269 calls at 350 ms and 644 at 850 ms, still climbing. The real page renders charts, so expect a lower but still unbounded rate. The verifier added the offline-pause behaviour. Line numbers are correct. API-37g's fix adds the FORBIDDEN rejection that feeds the unbounded branch, so fix this first or together. Severity stays high: it triggers on every normal use and floods the laptop's API, database and Eventor, but loses no data. (reviewer C3)

---

## Medium

### WEB-13 The persisted station cache is discarded on the first page load more than 24 h after the last persist, despite `gcTime: Infinity` and the "survives overnight" promise
- **Area / category:** app shell, state and data layer; functional.
- **Location:**
  - `packages/web/src/main.tsx:16-17` and `:78-87` (`maxAge` at `:82`, wrong comment at `:80-81`, no `buster`).
  - `packages/web/src/hooks/useStationSync.ts:8-9,42-43` (wrong comments) and `:47,52,57,62,67,72` (`gcTime: Infinity`).
  - `packages/web/src/lib/offline/persister.ts:9`.
  - `docs/guide/platform.md:49`.
- **What is wrong:** `PersistQueryClientProvider` gets `maxAge: 24 h`. On restore the library checks `Date.now() - persistedClient.timestamp > maxAge` for the whole client and, if expired, calls `removeClient()` without hydrating. A per-query `gcTime: Infinity` plays no part, so the comments and the guide are wrong. No `buster` is set, so a cache written by an older bundle is hydrated into new code unchanged.
- **Scenario:** stations are synced on Friday at 18:00 and powered off. On Sunday at 08:30 at an arena with no network, the page load finds a 38 h old cache and deletes it: no runner list, no runner DB, no warning. The timestamp is the last persist, which also happens while offline, and expiry needs a page load (reload, restart, discarded tab), so a station used offline on day 1, or a laptop that only slept, is not affected. The usual evening-before gap (about 14 h) works.
- **Fix (S):** raise `maxAge` to 7 days, or `Infinity` for a single-laptop tool. If a `buster` is added, bump it only on a real cache-shape change: it wipes the whole cache, including persisted paused mutations (SYNC-25), and a bump loaded offline at the arena reproduces this failure. SYNC-19 proposes `buster: nameId` for the same option, so combine both into one string. Fix the two comments and the guide. Unit test: `persistQueryClientRestore` with the app's real options must hydrate a 30 h old cache.
- **Verdict:** confirmed in part. A scratch vitest against the installed persist library showed a 14 h old cache hydrating and a 30 h old one removed. Refuted: that the clock is "time since last online" (the "day 2" variant fails when the station ran offline on day 1). The link to the shell's missing cached dashboard (WEB-03) was not checked. SYNC-19, SYNC-25 and SYNC-28 touch the same options block. (reviewer A4)

### WEB-14 `useExternalChanges` invalidates whole routers on every runner, card or punch change, including this tab's own writes, and cancels in-flight refetches
- **Area / category:** app shell, state and data layer; performance.
- **Location:**
  - `packages/web/src/hooks/useExternalChanges.ts:10-20` (`COUNTER_TO_ROUTERS`), `:24,38-45` (5 s poll, visible tabs only), `:62-84` (`utils.<router>.invalidate()`).
  - `packages/web/src/pages/CompetitionShell.tsx:414` and `:1033-1036` (mount).
  - `packages/api/src/routers/event.ts:659-702` (`counterState`) and `:625-657` (`changeWatermarks`, no caller).
  - `packages/web/src/pages/RunnerManagement.tsx:126-131`, `packages/web/src/pages/FinishStation.tsx:119-122` (own invalidations).
  - `packages/api/src/routers/lists.ts:77-232` (`resultList`, uncached).
- **What is wrong:** `counterState` returns `MAX(updated_at)` per table, and `oClub` is the runners watermark again, so one readout invalidates the `runner`, `lists`, `competition`, `club` and usually `cardReadout` routers. `invalidate()` ignores `staleTime` and refetches every active query in them. There is no throttle, delta or dedupe, so a tab's own write is refetched twice (its `onSuccess`, then the poll). After a reload the persisted, non-event-scoped `counterState` seeds `prevCounters`, so the first live answer invalidates everything right after the initial fetch; a competition switch does the same. `invalidate` defaults to `cancelRefetch: true`, so on a link where `runner.list` takes over 5 s it may never finish while activity continues. `race`, `draw` and `tracks` are unmapped and never refreshed. `changeWatermarks` says it replaces `counterState` but nothing calls it.
- **Scenario:** a 2,000-runner event, several visible Results screens and station tabs on a tethered uplink. Each card read makes every Results tab refetch `resultList` (the server re-matches every card's punches per call) and station tabs refetch `runner.list` and the dashboard every 5 s. The batch exceeds the 3 s service-worker timeout and stale answers are served as live (SYNC-16).
- **Fix (S-M):** pass `{ cancelRefetch: false }` first. Keep router-level marking with `refetchType: 'none'` and a throttled refetch (15-30 s) for `runner.list` and `lists.*`. Do not suppress "own" changes by settle time: with `MAX(updated_at)` an external write in the same window would be dropped; drop the heavy `onSuccess` invalidations instead. Seed `prevCounters` only from a fetch made in this mount and key it by event. Cache `resultList` server-side per runners/cards watermark. Adopt or delete `changeWatermarks`. Tests: a hook test with a fake counter sequence, and one that enumerates appRouter keys and fails on an unmapped event-scoped router.
- **Verdict:** confirmed from code reading in both reports; no test run. Narrowed: only mounted queries refetch, so payloads are per page, and the poll runs only in visible tabs. Payload sizes and server cost are estimates. The claim that the cloud image serves JSON uncompressed (WEB-59) was not confirmed: both nginx configs gzip JSON. `eventor.runnerDbDump` is unmapped and unaffected. Related to SYNC-16 and API-37o. (reviewer A5; also E2)

### WEB-15 One app-level error boundary: a render error on any page takes down the whole shell or kiosk, "Try again" cannot recover a failed lazy chunk, and provider errors have no boundary
- **Area / category:** app shell, state and data layer; stability.
- **Location:**
  - `packages/web/src/App.tsx:61-62` (providers outside the boundary), `:74-103` (the only boundary), `:14-16` (lazy shell, kiosk and start screen).
  - `packages/web/src/components/ErrorBoundary.tsx:21-45`.
  - `packages/web/src/pages/CompetitionShell.tsx:55-73`, `:620-647` (one `Suspense`, no boundary), `:256-259` (cleanup).
  - `packages/web/src/context/DeviceManager.tsx:410-427,820-825`.
  - `packages/web/src/pages/KioskPage.tsx:78-84,475,731-755`; `packages/web/src/pages/StartScreenPage.tsx:90`.
  - `packages/web/vite.config.ts:47-51`; `packages/web/src/main.tsx` (no global error listeners).
- **What is wrong:** a throw in any of the shell's 19 lazy pages replaces header, tabs, `CardNotification` and the open registration dialog. The unmount runs `setCompetitionNameId(null)`, so offline queueing of card reads stops (SI-03) and the kiosk channel closes. On the kiosk, the fallback stops `recordFinish`, receipts and auto-print, and never resets itself. "Try again" only clears state; React caches a rejected `lazy` import, so a chunk failure rethrows until a reload. `DeviceManagerProvider` and `PrinterProvider` sit outside the boundary, so an error in `ReaderConnectionDialog` unmounts the root. The fallback is hard-coded English, and there is no `unhandledrejection`, `error` or `vite:preloadError` listener.
- **Scenario:** a class with unexpected data makes the Results page throw during results service. The operator loses the whole station UI; browser Back then "Try again" would recover, but nothing says so. A reload drops the Web Serial connection and the in-memory recent-cards list.
- **Fix (S):** add a boundary around the `Suspense` at `CompetitionShell.tsx:620`, reset by a reset-key prop in `componentDidUpdate` or keyed by the first route segment, not by `location.pathname`. Give the kiosk and start screen their own dark, translated boundary, with inner ones around `ReadoutScreen` (keyed by `screen.card.id`, overlapping SI-32) and `MapPanel` (no-map fallback). Handle chunk errors with a bounded `window.location.reload()` (sessionStorage counter) via `vite:preloadError` plus a message regex, never a timed state reset, which would loop. Wrap the reader and printer dialogs, translate the fallback, add a global rejection logger. Unit test: a child throws once and the boundary resets on key change.
- **Verdict:** confirmed for the structural defect; scratch vitest showed React 19.3 `lazy` rethrowing the cached rejection. Narrowed: the service worker precaches every JS chunk, so chunk failure needs a first load, no service worker or an evicted cache, and the kiosk chunk loads at page load, not "after some hours". No concrete kiosk trigger was found: lost WebGL context is handled at `VectorMapLayer.tsx:325`. With the server up, readouts are still stored. The BLD-10 path does not reach page chunks. No client-log endpoint exists. (reviewer A6; also E6, D7)

### WEB-16 Kiosk receipt requests forwarded by the shell fail silently, and the forwarder stays bound to a closed channel after a back/forward competition change
- **Area / category:** app shell, state and data layer; functional.
- **Location:**
  - `packages/web/src/pages/CompetitionShell.tsx:271-317` (silent `return` at `:281`, `.catch(() => {})` at `:315`) and `:233-261` (nameId effect).
  - `packages/web/src/context/DeviceManager.tsx:268-291,783`.
  - `packages/web/src/context/PrinterContext.tsx:178-197`.
  - `packages/web/src/pages/KioskPage.tsx:349-354`; `packages/web/src/lib/kiosk-channel.ts:99-102`.
- **What is wrong:** the `kiosk-print-receipt` handler swallows every failure. `printerPrint` throws "Printer not connected" before `setLastError`, so that case leaves no trace; a USB write error only tints the printer indicator. The kiosk sends fire-and-forget and the message union has no result type. Second, the subscribe effect reads `getKioskChannel()` (a stable ref read) once; `setCompetitionNameId` closes the old channel, clearing its listeners, and the effect is not keyed on `nameId`. The shell stays mounted when browser back/forward moves between two event URLs, so print requests for the new competition are never forwarded.
- **Scenario:** at a paired finish kiosk the receipt printer loses USB. No receipt prints, the kiosk looks normal, and the operator's tab shows nothing until runners ask for splits.
- **Fix (S):** catch per step, show an error next to the printer indicator and log the runner id; add a `kiosk-print-result { ok, reason }` member to `KioskMessage` and handle it in `KioskPage` ("no receipt, ask the desk"). Add `nameId` to the subscribe effect's deps. Paper-out needs a printer status query, outside this fix. Tests: a handler test with a throwing `printerPrint`, and a nameId change re-subscribing.
- **Verdict:** confirmed from code reading; no test run. Narrowed: paper-out is probably not detected by this code at all (`print` only awaits `sendBytes`), and the channel bug needs back/forward, since in-app navigation goes through `/` and unmounts the shell. `printerPrint` depends on `receiptLabels`, so a language change re-subscribes by accident. Sub-claim 2 alone would be low. Related to SI-03 and SYNC-03. (reviewer A8)

### WEB-17 Permissions panel: one click rotates the kiosk key and breaks every kiosk at once, and failed revoke or rotate calls show nothing
- **Area / category:** app shell, state and data layer; functional.
- **Location:**
  - `packages/web/src/components/PermissionsPanel.tsx:28-33` (mutations without `onError`), `:151-153` (only error rendering), `:184-191` (revoke), `:213-229` (rotate and copy).
  - `packages/web/src/i18n/locales/en/event.json:308-310` and `sv/event.json:308-310`.
  - `packages/api/src/routers/event.ts:987-994`; `packages/api/src/db.ts:62-74`.
- **What is wrong:** the primary "Generate / rotate key" button calls `regen.mutate()` with no confirmation and no pending state, and always replaces an existing key. With auth on, `resolveEvent` reads the key from the database on every request, so every kiosk and start screen fails on its next tRPC or REST call, not within 60 s (only the map-document cache of API-37e lags). `revoke` and `regen` have no error handling and the QueryClient has no global handler. Revoke has no confirmation. `void navigator.clipboard.writeText(...)` has no catch, and on plain http to a LAN address `navigator.clipboard` is undefined, so the click throws and nothing happens. The help text does not warn.
- **Scenario:** mid-event an organiser opens Event > Permissions to copy the link for one more tablet and clicks the dark rotate button next to "Copy kiosk URL". Every running kiosk stops immediately and must be reopened with the new URL. A revoke that fails on a bad link leaves the row with no message.
- **Fix (S):** offer "Generate" only when no key exists; put "Rotate" behind a confirm that says kiosks fail immediately; disable both while pending; render `revoke.error` and `regen.error`; confirm revoke; guard a missing `navigator.clipboard` and catch the promise. Update en and sv help strings and `e2e/permissions.spec.ts:64`, which clicks the button to create the key.
- **Verdict:** confirmed from code reading, and worse than claimed on timing. A rotate on a venue box during a lease is later overwritten by the settings refresh (noted in the offline-sync review), which this fix does not address. Related to API-37e. (reviewer A9)

### WEB-18 The app shell's state logic has no tests; the existing shell tests cover pure helpers only
- **Area / category:** app shell, state and data layer; tests.
- **Location:**
  - `packages/web/src/__tests__/trpc-cache-scope.test.ts:1-20`.
  - `packages/web/src/context/CurrentUserContext.tsx:24-65`; `packages/web/src/context/CapabilitiesContext.tsx:13-31`.
  - `packages/web/src/pages/CompetitionShell.tsx:113-261`; `packages/web/src/hooks/useExternalChanges.ts:33-87`.
  - `packages/web/src/main.tsx:51-65` and `packages/web/src/lib/trpc.ts:21-31` (duplicated header logic).
  - `e2e/session-recovery.spec.ts:9-39`; `e2e/offline.spec.ts:172-199`.
- **What is wrong:** no unit test imports `CurrentUserProvider`, `CapabilitiesProvider` (fail-open `has`), `CompetitionShell`, `useExternalChanges`, `ErrorBoundary`, `useLocalStorage`, `useSort` or `useTableSelection`. `trpc-cache-scope.test.ts` only checks that `&event=` is appended, not cache isolation (WEB-01). `session-recovery.spec.ts` passes via the 600 ms retry, the visibility retry or a full reload alike, and never fails `users.me`. `offline.spec.ts` never enters an event while offline, so the shell's offline fallback (WEB-03) is untested. Only `mobile-layout.spec.ts:126` switches events, asserting the map viewport.
- **Scenario:** a refactor of the shell effect or `CurrentUserProvider` reintroduces cross-competition data or the blank spinner (WEB-04) with every test green.
- **Fix (M):** `packages/web` has no jsdom, happy-dom or testing-library and no vitest environment, so first extract pure functions (the counter diff in `useExternalChanges.ts:56-87`, the value derivation in `CurrentUserContext.tsx:50-59`) and table-test them, or add those dependencies. Add E2E for switching between two competitions with a failed and a late request, and for re-entering an event offline. Extend `trpc-cache-scope.test.ts` once WEB-01 is fixed. Make `session-recovery.spec` assert no navigation when the retry succeeds, and add a case that fails `users.me`.
- **Verdict:** confirmed by listing all 166 web test files and grepping them. Corrected: the fix is at least M because of the missing DOM test setup. A test gap is no defect by itself; its weight comes from WEB-01, WEB-03, WEB-04 and WEB-14. Related to SYNC-34 and SYNC-43. (reviewer A12)

### WEB-19 Rental-card tick, receipt tick and payment method carry over to the next runner when the dialog is reopened from a card read
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:272-322` (pending-card effect; resets at `:277-290`).
  - `packages/web/src/components/RegistrationDialog.tsx:713-714` (non-sticky success), `:745` (Esc close), `:752-761` (reset on open, skipped with a pending card).
  - `packages/web/src/components/RegistrationDialog.tsx:184-186,189` (`clearForm`) and `:427-433` (mount-time default payment).
  - `packages/web/src/context/RegistrationDialogContext.tsx:63-73`; `packages/web/src/pages/CompetitionShell.tsx:654`.
- **What is wrong:** the dialog is always mounted and returns `null` when closed, so its state survives. In non-sticky mode a success or an Esc close only calls `closeRegistration()`. On the next open with a pending card, `clearForm` is skipped and the pending-card effect does not reset `isRentalCard`, `printReceipt` or `paymentMode`. The default payment also differs by path: the mount effect picks `methods[0]`, `clearForm` prefers "billed", and the `paymentDefaultApplied` reset lets a config refetch switch the method under an open form.
- **Scenario:** runner A is registered with "Rental card" ticked, paid by Swish. Runner B's own card is read and the operator clicks the notification. The form opens with the rental tick and Swish; if unnoticed, B is charged and stored with a card fee and gets the "return rental card" banner at readout.
- **Fix (S):** in the pending-card effect call `clearForm()` and then set the card and owner fields; this also covers the Esc path. Use one default-payment helper that reads the current config, and drop or align the reset at `:189`. Test the reset logic as a pure function and add an E2E that registers a rental runner, then opens the dialog from a second card read.
- **Verdict:** confirmed from code reading; no test run. Wider than claimed: Esc and backdrop close carry over too. Sticky mode after success is not affected. `e2e/rental-cards.spec.ts:143` never opens the dialog twice. (reviewer B7)

### WEB-20 Registration can be submitted twice while the receipt prints, and the offline path has no guard
- **Area / category:** registration, runners, cards, clubs and search; stability.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:584-721` (`handleSubmit`), `:638-649` (offline branch), `:663-682` (awaited logo fetch `:665-667` and print `:668-681`), `:1153-1164` (button, disabled at `:1156`).
  - `packages/api/src/routers/runner.ts:152` (no duplicate check without a card) and `:420` (CONFLICT on a taken card).
- **What is wrong:** the button is disabled only by `createMutation.isPending`. After the mutation resolves, the handler awaits a logo fetch and `printer.printRegistration` before clearing or closing, with the form intact and the button enabled. The offline branch has no guard and uses a new `crypto.randomUUID()` per call. The window is long only when a receipt is printed, which is opt-in per runner (`printReceipt` defaults to false); otherwise it is milliseconds. The awaited logo fetch can stretch it further on a poor network.
- **Scenario:** receipt printing on, the operator presses Enter, sees nothing change while the receipt prints, and presses Enter again. Without a card number a second runner, with a second fee, is created. With a card number the second call gets CONFLICT and "Registration failed" shows over a registration that succeeded, usually only briefly. Offline, a double Enter queues two `runner.registered` events with different tempIds.
- **Fix (S):** a ref set at the top of `handleSubmit` for the early return (state alone does not stop two submits in one tick), plus state for `disabled`, both cleared in `finally`. Move printing after clear or close, fire and forget with its own error toast; the print arguments are already captured in locals. Test: two rapid submits create one runner, online and offline.
- **Verdict:** confirmed from code reading; not reproduced. Narrowed to the receipt-printing configuration. Not SYNC-12 (offline payload content); the non-idempotent ingest of `runner.registered` noted under SYNC-20 is related. (reviewer B8)

### WEB-21 Escape inside the club or class dropdown also closes the registration dialog, or clears the whole form in sticky mode
- **Area / category:** registration, runners, cards, clubs and search; stability.
- **Location:**
  - `packages/web/src/components/SearchableSelect.tsx:80-90`.
  - `packages/web/src/components/RegistrationDialog.tsx:724-749` (dialog handler), `:173-193` (`clearForm`, `isFormDirty`), `:882` and `:947` (club and class selects).
- **What is wrong:** both components add bubble-phase `keydown` listeners on `document`. `SearchableSelect` closes its popup on Escape without stopping the event, and the dialog only yields to its own name-suggestion list, so one key press runs both. Sticky mode with any field set calls `clearForm()`, which wipes every field including the card number, and sends `kiosk-reset`; non-sticky mode closes the dialog and sends `kiosk-reset`.
- **Scenario:** the operator has filled name, card and birth year, opens the class dropdown and presses Esc to dismiss it. Sticky: the form is empty and the kiosk resets. Non-sticky: the dialog disappears. Nothing is persisted; the cost is re-entering the form and re-reading the card.
- **Fix (S):** register the select's listener in the capture phase and call `stopImmediatePropagation()` while open; this works wherever focus is. A React `onKeyDown` with `stopPropagation()` must sit on the container, since with six or fewer options there is no search input and focus stays on the trigger. A `defaultPrevented` check in the dialog only works if the select also moves to the capture phase, because the dialog's listener is registered first. E2E: open each select, press Esc, assert the form is intact.
- **Verdict:** confirmed from code reading; a scratch vitest could not run (jsdom missing). The proposed `defaultPrevented` alternative was refuted as written. Other document-level Escape handlers hosting a `SearchableSelect` were not surveyed. (reviewer B9)

### WEB-22 Registration errors are replaced by a generic message, a duplicate card leaves a submittable form, and manual card entry does nothing when the API is unreachable
- **Area / category:** registration, runners, cards, clubs and search; engineering.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:617-637` (inner `catch {}` at `:634-637`), `:718-720` (outer catch).
  - `packages/web/src/components/RegistrationDialog.tsx:113-116,350-359,828-841` (duplicate check, pre-fill, banner), `:1154-1156` (button).
  - `packages/web/src/components/RegistrationDialog.tsx:436-473` (`startManualCard`, fetch at `:440`; callers `:859,868`).
  - `packages/api/src/routers/runner.ts:163-166,420`.
- **What is wrong:** the inner catch discards the TRPCClientError, logs nothing and throws "Registration failed", so card conflicts (the server names the holder), missing class, lease, permission and network errors look the same. With a known card the dialog pre-fills the existing runner and leaves Register enabled; submitting with the card unchanged while online always fails generically. `startManualCard` awaits `findByCard.fetch` without a catch: on a server error the rejection is unhandled, and offline the query pauses (default `networkMode`) until the connection returns, so Start does nothing. A cached result within the 5 s `staleTime` returns at once.
- **Scenario:** a hire card still linked to yesterday's runner is handed out. The operator types the new name and presses Register: "Registration failed", no hint the card is taken.
- **Fix (S):** map `err.data?.code === 'CONFLICT'` to the `duplicateCardWarning` translation (the server text is English only), show "server not reachable, try again" for network failures, and `console.error` the original. Disable Register while `duplicateCheck.data` is set, re-enable it when the card field changes, or add a "move card" action. In `startManualCard`, add try/catch plus a `navigator.onLine` check, a timeout or `networkMode: 'always'`, falling through to the form. Tests for each error mapping.
- **Verdict:** confirmed from code reading. Narrowed: "always fails" holds only online with the card unchanged; offline the registration is queued with no check, a separate issue. (reviewer B10)

### WEB-23 Card auto-fill from the cached runner database fails on the first read of a card while online, and owner data beats the Eventor lookup contrary to the doc
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:119-130` (lookups), `:327-347` (auto-fill effect), `:362-378` (owner-data effect), `:292` and `:394` (affected entry points), `:436-457` (manual path that works).
  - `docs/system/registration-and-readout.md:706-712`.
- **What is wrong:** the auto-fill effect depends on `[isOpen, cardLookup.data, clubs.data]` and bails while `duplicateCheck.isLoading`. With the runner DB dump cached, `cardLookupLocal` changes in the render where the duplicate check starts, the effect bails once, and no dep changes afterwards; the server lookup is disabled when the dump exists. Offline it works because a paused query has `isLoading` false. Second, the owner-data effect sets the name in the commit where the check resolves, and the auto-fill then bails on `name`, so SI owner data wins over Eventor with or without the dump, contrary to the doc (Eventor second, owner data third).
- **Scenario:** a desk laptop that also ran readout has the dump cached. Online, a known runner's card is read for the first time: name, birth year, sex and club stay empty. Manual card entry, a card whose `findByCard` result is cached, or `clubs.data` arriving late do fill.
- **Fix (M):** one pure `resolvePrefill({dbRunner, lookup, ownerData})` that decides all fields in the documented order once the inputs have settled, with a per-card ref against refill. Do not gate on `duplicateCheck.isFetched` alone: offline it stays false and would break the fill that works today (the owner-name effect already never fills offline). Unit-test the function; add an E2E variant of the card lookup test with `runnerDbDump` seeded.
- **Verdict:** confirmed in part. A scratch vitest against react-query 5.107.1 confirmed the query states; the component could not be mounted. Refuted: "never runs while online". Part 2 confirmed. `e2e/registration-dialog.spec.ts:254` covers only the no-dump, no-owner path. (reviewer B11)

### WEB-24 Runners search offers anchors that never match, or match everyone, because `runner.list` does not return their fields
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/lib/structured-search/anchors/runner-anchors.ts:380-431` (nation, punched, visited, control, rank), `:446-453` (started), `:474` (forest adjustment).
  - `packages/api/src/routers/runner.ts:391-414`; `packages/shared/src/types.ts:492-503`.
  - `packages/web/src/pages/RunnerManagement.tsx:44,144`.
- **What is wrong:** `createRunnerAnchors`, used only by the Runners page, reads `nationality`, `punchControlCodes`, `courseControlCodes`, `rank` and `cardStartTime`, which are optional on `RunnerInfo` and never set by `runner.list`. `punched`, `visited`, `control`, `rank` and `nation` never match, and their negations match everyone. `started` compares 0, so `started:<10:00:00` may match every runner. `forest:` uses adjustment 0, wrong only for courses with NoTiming legs. The anchors still appear in suggestions.
- **Scenario:** a control is reported stolen and the organiser types `punched:47`: 0 runners, read as "nobody punched it". `!punched:47` lists everyone.
- **Fix (M):** populate the fields behind an opt-in input flag sent only when such an atom is present (`runner.list` already runs a punch `groupBy`, DB-44; `rank` must be computed per class), or remove the anchors until the data exists. Introduce a required-field `RunnerListItem` type. Test the anchors against real `runner.list` output, not synthetic items.
- **Verdict:** confirmed from code reading; no test run. `matchTime`'s zero handling was not opened. `filter.test.ts` passes on synthetic items carrying the fields. RES-25 covers a different status-anchor issue. (reviewer B12)

### WEB-25 Runners page: delete and bulk mutations fail silently, and the bulk status list offers three values that cannot be applied
- **Area / category:** registration, runners, cards, clubs and search; stability.
- **Location:**
  - `packages/web/src/pages/RunnerManagement.tsx:126-137` (`deleteMutation`), `:175-210` (`bulkUpdateMutation`, `Number(bulkValue)` at `:207`), `:191` (confirm text), `:431-442` (bulk status options), `:52-94` (`handlePrint`).
  - `packages/shared/src/types.ts:206-223` (`STATUS_FILTER_OPTIONS`).
  - `packages/api/src/routers/runner.ts:648` (`status: z.number().int().optional()`).
- **What is wrong:** `deleteMutation` and `bulkUpdateMutation` have `onSuccess` only, nothing reads `.error`, and `packages/web` has no global mutation error handler. On failure the spinner stops and the selection stays. The bulk status select is built from `STATUS_FILTER_OPTIONS`, which includes the filter pseudo-values `not-started`, `in-forest` and `finished`; `Number('in-forest')` is NaN, sent as null (no tRPC transformer) and rejected by zod with a BAD_REQUEST nobody sees. The list also lacks Unknown (0), NoTiming and OutOfCompetition, so no status can be reset in bulk. Labels are hard-coded English. `handlePrint` awaits `utils.race.finishReceipt.fetch` without a catch, and `fetchLogoRaster` at `:87` has no `.catch` either.
- **Scenario:** at the end of the day the operator selects 40 runners and picks Set status, "Not yet started", to undo a wrong bulk DNS. The button spins briefly and nothing changes, with no message.
- **Fix (S):** add `onError` to both mutations and show the message in the bulk bar or a toast, keeping the selection. Extract the real status list from `RunnerInlineDetail.getStatusOptions` into a shared module (with Unknown = 0) and use it for the options and the confirm label at `:191`. Wrap `handlePrint` in try/catch with visible feedback and add `.catch(() => null)` to `fetchLogoRaster`. Test the option list and the error path.
- **Verdict:** confirmed by code reading of the whole page, the shared status list and the zod input; no test run. The verifier added the missing options and the uncaught `fetchLogoRaster`. The server-side timeout is DB-39, a cause of one failure mode, not the same defect. Medium kept: nothing is corrupted. (reviewer B13)

### WEB-26 Bulk actions apply to selected runners that the current filter no longer shows
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/hooks/useTableSelection.ts:8`, `:24-30` (`selectAll`), `:61-72` (`count`).
  - `packages/web/src/pages/RunnerManagement.tsx:170`, `:186`, `:205-207`.
  - `packages/web/src/pages/ClassesPage.tsx:87`, `:114`; `packages/web/src/pages/CoursesPage.tsx:284`, `:330`.
- **What is wrong:** `useTableSelection` keeps a `Set` of ids that is never reconciled with `items`. `selectAll` adds the visible ids to the previous set, `count` is `selected.size`, and the mutation sends `Array.from(selection.selected)`, while `allSelected` and `someSelected` look only at visible rows. Runners selected under an earlier filter stay selected after it changes. The count shown is truthful, but nothing shows which rows are hidden, and the header checkbox suggests the selection equals the visible rows. Deleted ids also stay selected, which only inflates the count, because the server ignores removed runners. The same hook is used with filtered lists on the Classes and Courses pages.
- **Scenario:** filter `class:H21`, tick 5 runners, change the filter to `class:D10`, use the header checkbox to select its 30 runners and set DNS. Bar and confirm say 35, and the 5 off-screen H21 runners are set to DNS too.
- **Fix (S):** intersect with the visible ids when applying (`filteredRunners.filter(r => selected.has(r.id))`), use that number in the button and confirm, and show "n selected (m hidden)"; or clear on filter change, at the cost of cross-search selections. Any pruning effect must compare against the unfiltered list and must not run while data is undefined during a refetch. Doing it in the hook also changes Classes and Courses; check them or make it opt-in. Unit-test the hook with a shrinking item list.
- **Verdict:** confirmed by code reading of the hook and every caller; no test run. A successful apply clears the selection, so stale ids come from filter changes, single deletes and failed applies. Medium kept. The Classes and Controls side is WEB-35. (reviewer B14)

### WEB-27 Clubs page still offers create, rename, delete and "show all", but the API stubs reject them and rename and delete fail silently
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/pages/ClubsPage.tsx:29-42` (delete mutation), `:69-86` (New club, Show all), `:208-222` (update mutation, shared debounce timer), `:239-254` (uncontrolled inputs), `:357-368`.
  - `packages/api/src/routers/clubRouter.ts:130-166` (stubs and their comment), `:16-22` (`club.list` ignores input).
- **What is wrong:** `club.create`, `club.update` and `club.delete` always throw PRECONDITION_FAILED ("Clubs are now global"). The router comment says the page shows them disabled; it does not. Create shows the error text. Rename (debounced, `defaultValue` inputs) and delete (confirm, no `onError`) show nothing, and there is no global error handler: the typed name stays in the input and the row stays. `club.list` never reads `showAll`, so the toggle only changes labels. One debounce timer serves name and short name, the pattern in WEB-07, moot while every update fails.
- **Scenario:** an organiser fixes a misspelt club name in the expanded row. The input keeps the new text, nothing is saved, and results still print the old name. Deleting a listed club after confirming leaves it in place with no explanation.
- **Fix (S-M):** if clubs stay read-only per event, render text instead of inputs, remove New club, delete, Show all and the create form, and delete the stubs only after the web stops calling them. A per-event rename override needs more than a runner `clubName` update, because Eventor clubs display the `club_directory` name and short names have no per-event storage. Update `docs/features.md:73` and the clubs guide page.
- **Verdict:** confirmed by code reading; no test run. Corrected: "delete an empty duplicate club" cannot happen, since `club.list` is derived from non-withdrawn runners, so every listed club has at least one runner. Medium kept: no data is lost. Related to DB-25 (free-text clubs share id 0) on the same page; fix together. (reviewer B15)

### WEB-28 Runner and card tables render every row, each with its own query observer, and re-render all of them on any page state change or refetch after a readout
- **Area / category:** registration, runners, cards, clubs and search; performance.
- **Location:**
  - `packages/web/src/pages/RunnerManagement.tsx:295-398` (rows), `:243-252` (withdrawn count).
  - `packages/web/src/pages/CardsPage.tsx:176-262`.
  - `packages/web/src/components/ClubLogo.tsx:30-32`; `packages/web/src/components/StatusBadge.tsx:8`.
  - `packages/web/src/hooks/useExternalChanges.ts:10-24`.
- **What is wrong:** neither table is paginated or virtualised, and rows are inline JSX in the page component. Every row mounts `ClubLogo`, which calls `trpc.club.logoMap.useQuery` (one observer per row on one shared query, so 2,000 subscriptions, not 2,000 requests), and `StatusBadge` with its own i18n hook. Any page state change (new selection `Set`, row expand via URL param, bulk dropdown) re-renders every row. `useExternalChanges` invalidates the whole `runner` and `cardReadout` routers whenever a counter moves, which every readout does, including the tab's own writes.
- **Scenario:** with 2,000 runners, each checkbox click or row expand re-renders about 2,000 rows of 10 cells plus two hook-bearing children each, plausibly 100 ms or more on an arena laptop. During the finish rush this also happens on most 5 s polls where data changed.
- **Fix (M):** first extract `RunnerRow` and `CardRow` as `React.memo` components with primitive props (`selected`, `expanded` booleans) and stable callbacks; read `logoMap` once in the page and pass a boolean or resolved id. Do not pass `eventorId={runner.clubId}` to `ClubLogo`: the map only holds clubs with a stored logo, so that would issue failing image requests for the rest. Then consider windowing the tbody and narrowing the invalidation to `runner.list`.
- **Verdict:** confirmed by code reading; not measured in a browser, so the lag is an estimate. Narrowed: "about every 5 s" is an upper bound (only when a counter moved, the tab is visible and no performance-sensitive page is mounted), and an identical refetch does not re-render thanks to structural sharing. Medium at 2,000 runners, low for small events. Server cost is DB-44, API-37q and SI-38. (reviewer B16)

### WEB-29 Fuzzy club match pre-selects unrelated clubs from SI card owner data
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/lib/fuzzy-club-match.ts:17-20` (suffix list), `:52-67` (token overlap: two-way prefix at `:58`, ratio at `:63`, score at `:67`), `:78` (threshold 60), `:87` (tie-break by runner count).
  - `packages/web/src/components/RegistrationDialog.tsx:304-307`, `:405-408`.
- **What is wrong:** the score is `50 + 35 x ratio`, with the ratio taken over the larger token count, so one matched token out of three scores 62 and passes the threshold of 60. Generic words such as `orientering` and `ifk` are not stripped, prefixes match in both directions with no minimum length. Ties go to the club with the most runners, which favours large wrong clubs. Both call sites call `setClubId(match.id)` with no sign that it is a guess.
- **Scenario:** reproduced against a five-club list: "Järfälla Orientering" and "Södertälje SK" match "Södertälje Nykvarn Orientering", "IFK Lidingö" matches "IFK Göteborg Orientering", and "L" matches "OK Linné". This fires only when the card's owner club has no exact or suffix-stripped match. At a busy desk the runner is registered, and possibly invoiced, under the wrong club.
- **Fix (S):** add the generic words to the stop list, compute overlap over the query's distinctive tokens, keep the reverse prefix only with a minimum length of 4-5 (to keep genitives like "Kungälvs"), raise the threshold to about 75, and return null on a tie only below exact matches (an existing test relies on runner-count tie-breaks at score 100). Add these negative cases to `lib/__tests__/fuzzy-club-match.test.ts`. A "confirm the suggestion" UI is a separate, larger change.
- **Verdict:** confirmed by code reading and a scratch vitest (since deleted) that reproduced every mapping, plus "Orientering" and "O". The club is visible in the form, so "silently" means unflagged rather than hidden. Medium kept. (reviewer B18)

### WEB-30 A failed or paused list query is shown as an empty list on the Runners, Cards and Clubs pages
- **Area / category:** registration, runners, cards, clubs and search; stability.
- **Location:**
  - `packages/web/src/pages/RunnerManagement.tsx:257-266`.
  - `packages/web/src/pages/CardsPage.tsx:163-174`.
  - `packages/web/src/pages/ClubsPage.tsx:127-133`.
  - `packages/web/src/components/RunnerInlineDetail.tsx:97-110` (return null at `:110`).
  - `packages/web/src/main.tsx:19-27`.
- **What is wrong:** the three pages branch only on `isLoading` and row count and never read `isError`, and there is no global query error handler. After one retry a failed `runner.list`, `cardReadout.cardList` or `club.list` with no cached data shows "No runners", "No cards found" or "No clubs". `RunnerInlineDetail` returns null when `runner.getById` fails. Worse, from TanStack v5 semantics (not reproduced): if the browser is already `offline`, the query is paused with `isLoading` and `isError` both false, so the same empty text appears and no error ever arrives.
- **Scenario:** the cache is persisted for 24 h and shared across tabs, so the empty state needs a cold key: first visit in this browser profile, a different input (`club.list {showAll:true}`), or a server 500 on a cold key. The page then reports "No runners" for an event with 2,000 entries, which at an arena reads as data loss.
- **Fix (S):** branch on `isPending` or `!data`; show an error row with the tRPC message and a Retry button calling `refetch()`, and an "offline, no cached data" message when `fetchStatus === 'paused'`. Copy the error-row pattern of `CardDetailPanel` (`CardsPage.tsx:407-410`). Keep stale data with a "could not refresh" banner when `isError && data`. Add an error row to `RunnerInlineDetail`.
- **Verdict:** confirmed by code reading; no test run. The verifier narrowed the scenario (a cached list shows within 24 h) and added the paused-query case, which an `isError` branch alone does not cover. Medium kept. (reviewer B19)

### WEB-31 The registration fee and payment mapping has no test at any level, the editor and selection hook are untested, and the search matchers are duplicated across the anchor files
- **Area / category:** registration, runners, cards, clubs and search; tests.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:584-722`, `:591-602` (fee, paid, payMode inline in `handleSubmit`).
  - `packages/web/src/components/RunnerInlineDetail.tsx:73-96`; `packages/web/src/hooks/useTableSelection.ts:7-73`.
  - `packages/web/src/lib/structured-search/anchors/runner-anchors.ts:20-47`, `:74-95`, `:151-157`; `result-anchors.ts:66-72`; `track-anchors.ts:65-72`; `card-anchors.ts:40-88`.
  - `e2e/runners-bulk.spec.ts:21-22`; `e2e/registration-dialog.spec.ts:254-290`; `e2e/rental-cards.spec.ts:143`.
- **What is wrong:** `packages/web` has no DOM renderer or testing-library, and no test references `RegistrationDialog`, `RunnerInlineDetail`, `useTableSelection` or `SearchableSelect`. The fee/paid/payMode mapping is inline and is asserted by no test at all, E2E included. E2E covers one bulk status test, one rental registration and the lookup test. `matchString` and `matchNumber` are copied in all ten anchor files, `matchBool` in six, `parseTimeValue` in two plus a millisecond variant in `track-anchors.ts`. The matchers are tested through `filter.test.ts` and `new-anchors.test.ts`, so the duplication is a maintenance cost, not a coverage gap.
- **Scenario:** a change maps `billed` to the wrong `paid` value and no test fails. A wildcard-escaping fix must be made in ten files; an HH:MM fix in two or three.
- **Fix (M):** extract and unit-test in the node vitest setup `buildRegistrationPayload(form, classes, cardFee)`, also used by the offline branch (`:638-646`), `resolvePrefill` (WEB-23), `mergePendingEdits` (WEB-07) and selection reconciliation (WEB-26). Hook tests need a renderer or reducer extraction. Move the matchers to `lib/structured-search/match.ts`, keeping the track variant as a parameter. Add the E2E cases named in WEB-10, WEB-05 and WEB-19.
- **Verdict:** confirmed in part by reading the files, hashing the matcher bodies and listing test files; no test run. Refuted: `matchBool` and `parseTimeValue` are not in ten files, the matchers are tested, and "no tests below E2E" ignores `registration-class-filter.test.ts`, `registration-trends.test.ts` and two `renderToStaticMarkup` tests. The per-item RegExp cost is negligible. The missing offline-branch fields are already SYNC-12. (reviewer B22)

### WEB-32 Event settings forms are seeded once from cached query data, possibly another competition's or a day old, and then write those stale values back
- **Area / category:** classes, controls, event settings, library and trends; functional, cross-competition (not security).
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:1229-1240`, `:1246-1249`, `:1329`, `:1348-1351`, `:1379-1388`, `:1408`, `:1465`, `:1479`, `:1644-1657` (payment, receipt and Sheets cards).
  - `EventPage.tsx:892-898`, `:908-931` (Online Input); `:653-659`, `:666-683`, `:800-806` (LiveResults); `:28` (`dashboard.isLoading`, the only gate).
  - `packages/web/src/pages/CompetitionShell.tsx:236-253`; `packages/web/src/main.tsx:19-27`, `:76-88`.
- **What is wrong:** five cards copy `config.data` into local state once and never re-sync. The queries take no input, so their keys carry no competition; the whole cache is persisted for 24 h with no buster; and a competition switch only calls `utils.invalidate()`, which leaves inactive data in place. The first data a new EventPage sees is the cached one; the fresh response is ignored. Writes are unconditional on blur or toggle, and the Online Input and LiveResults saves fire when local state differs from the fresh config; the server writes to the competition in the URL.
- **Scenario:** (1) the operator leaves competition A and opens B, whose page shows A's settings. Tabbing through the fee field sends 30 to B; Save in the Sheets card sends B's readouts to A's sheet; enabling Online Input with A's unit showing pulls A's radio punches into B. (2) In one competition, another admin changed the Swish number; revisiting the tab, or reloading, seeds yesterday's value and a focus and blur reverts it.
- **Fix (M):** gate the cards on data fetched after mount, with a read-only offline branch, since `isFetchedAfterMount` alone hides them for good offline. Re-seed local state when `config.dataUpdatedAt` changes and the field is neither dirty nor focused. Send a field only when it differs from `config.data`, and payment methods only on a real toggle. Add an E2E: open A, switch to B, assert B's values and that focus and blur send no mutation.
- **Verdict:** confirmed by code reading and a scratch vitest (since deleted) showing an invalidated inactive key returns the old data first. Recategorised from security (writes use the operator's own rights) and lowered from high to medium: the value written is the one shown. SYNC-19 shares the root cause; its fix removes scenario 1 but not scenario 2. (reviewer C1)

### WEB-33 Destructive actions with no or uninformative confirmation: delete class with runners, delete control used in courses, clear station backup memory, bulk radio and AIR+ change
- **Area / category:** classes, controls, event settings, library and trends; functional.
- **Location:**
  - `packages/web/src/pages/ClassesPage.tsx:132-136`; `packages/web/src/i18n/locales/en/classes.json:26`; `packages/api/src/routers/classRouter.ts:444-457`.
  - `packages/web/src/pages/ControlsPage.tsx:116-120`; `en/controls.json:73`; `packages/api/src/routers/control.ts:1091-1119`.
  - `ControlsPage.tsx:1815-1826`, `:1880-1886` (Clear memory); `:138-152` (bulk handlers), `:383-408` (select markup).
  - `packages/web/src/pages/LibraryGroupsTab.tsx:157-162`; `packages/web/src/pages/LibraryControlsTab.tsx:312`.
- **What is wrong:** (a) class delete asks only "Remove class "H21"?"; the row knows `runnerCount` but neither shows nor blocks it, the API soft-deletes with no runner check, and there is no restore. The runners stay on start and result lists, but the class vanishes from the Classes page, class pickers and the public roster, and LiveResults sends its runners with an empty class name. (b) control delete names only the code, though the API removes it from every course and re-materialises variants. (c) Clear memory erases the coupled station's backup with no confirm, beside Read memory. (d) bulk radio and AIR+ selects apply on change with no confirm. (e) removing a group member and deleting a series control are one click.
- **Scenario:** after the race, with a field control's backup not yet read, the operator clicks Clear memory instead of Read memory, and the only station-side copy needed for a protest is gone.
- **Fix (S-M):** refuse class delete server-side while runners exist (or add a restore) and show the count; show the course usage for controls (needs detail data, or use `runnerCount`); confirm Clear memory naming the station and whether `lastReadSerial` matches; confirm bulk radio and AIR+ like `ClassesPage.handleApplyBulk`; confirm member removal.
- **Verdict:** confirmed in part by code reading; no test run. Refuted: runners of a deleted class do not vanish from result lists (`lists.ts:238-242` is the uncalled `classesWithCounts`), so (a) is a missing guard, not result loss. Medium kept, on the low side. Related: SI-06. (reviewer C4)

### WEB-34 Classes and Controls pages: every mutation failure is silent, typed input is discarded, and selects keep showing the unsaved value
- **Area / category:** classes, controls, event settings, library and trends; stability.
- **Location:**
  - `packages/web/src/pages/ClassesPage.tsx:60-70`, `:92-98`, `:119-130`, `:671-676` (class update), `:705-708`, `:721-733`.
  - `packages/web/src/pages/ControlsPage.tsx:96-114`, `:231`, `:659-664` (control update), `:715-720`, `:733-738`, `:750-755`.
- **What is wrong:** `class.update/delete/bulkUpdate/reorder/createFromPresets` and `control.update/delete/upsertConfig/setAirPlusConfig` have no `onError` and render no error, and there is no global handler. Text fields save on blur and null the edit state unconditionally, so a rejected save snaps back with the text gone. `editSex`, `editCourseIds` and `editStatus` are never cleared, so a select keeps the unsaved value and masks later server changes. The presets dialog shows nothing when `createFromPresets` fails. Edit controls are not capability-gated, so a view-only user gets silent FORBIDDENs. `control.update` and the class procedures are lease-guarded; `upsertConfig` and `setAirPlusConfig` are not (that is API-37n) but still fail silently on FORBIDDEN or network error.
- **Scenario:** with the event checked out to the venue box, an organiser on the cloud sets control 45 to Bad. The server refuses with PRECONDITION_FAILED, the select still shows Bad, the badge shows OK, and readouts keep giving MP for 45.
- **Fix (M):** one shared error surface for both pages, `onError` on every mutation, translated messages for the lease PRECONDITION_FAILED and FORBIDDEN codes, and network failures on the same path. Null the text edit state only in `onSuccess`; clear the select states in `onSettled`. Hide or disable edit controls without `event.manage` or `courses.edit`. Show `createFromPresets.error`. Fix this with API-37n, or radio and AIR+ changes will start failing silently under a lease.
- **Verdict:** confirmed in part by code reading; no test run. Refuted: `upsertConfig` and `setAirPlusConfig` are not lease-guarded; `control.update` is `coursesEditOrReviewRaceProcedure`. Dropped `ControlsPage.tsx:1557-1566`, which uses `mutateAsync` in try/catch. Medium kept, arguably high for the status case, since a wrong control status changes results. (reviewer C5)

### WEB-35 Bulk actions act on rows hidden by the current filter on Classes and Controls, and Controls select-all compares set sizes
- **Area / category:** classes, controls, event settings, library and trends; functional.
- **Location:**
  - `packages/web/src/hooks/useTableSelection.ts:7-8`, `:70`.
  - `packages/web/src/pages/ClassesPage.tsx:85-87`, `:104`, `:113-116`.
  - `packages/web/src/pages/ControlsPage.tsx:66`, `:102-107`, `:138-152`, `:186-191`, `:335-338`, `:377-378`, `:382`.
  - `packages/web/src/pages/RunnerManagement.tsx:170`; `packages/web/src/pages/CoursesPage.tsx:284`.
- **What is wrong:** the ClassesPage comment says selection is scoped to the visible list, but the hook's `Set` is never pruned, `count` is `selected.size`, and `class.bulkUpdate` applies to every id sent. The Classes header checkbox is correct, and the bar and confirm show the true count. ControlsPage keeps its own `selectedIds`, never pruned or cleared after a bulk action, and decides "all selected" by `selectedIds.size === items.length`: a stale selection of equal size shows a checked header and select-all clears it. The bulk radio and AIR+ selects then send the whole set with no confirm, and the map highlight uses it too.
- **Scenario:** select all 40 classes, filter to the 6 youth classes, set Fee = 0 and accept "for 40 classes?": all 40 get fee 0. On Controls, select 31-35, filter to radio and pick Public radio: the five hidden controls change at once (no confirm, WEB-33).
- **Fix (S):** fix it in the hook so Runners and Courses are covered too: expose the effective selection (`items.filter(isSelected)`) and derive `count`, confirm text and ids from it; make ControlsPage use the hook with `items.every/some`. Decide whether selection survives a filter change (prune or intersect at use). Unit-test the hook after the list shrinks.
- **Verdict:** confirmed by code reading; no test run. The verifier corrected the hook lines and extended the scope; the Runners side is WEB-26. Medium kept. (reviewer C6)

### WEB-36 Station programming: choosing a code-less control as target programs the station with code 0, reports success, and the programming record fails
- **Area / category:** classes, controls, event settings, library and trends; functional.
- **Location:**
  - `packages/web/src/pages/ControlsPage.tsx:289-290`, `:1076` (unfiltered picker list), `:1141-1147`, `:1170` (`targetCode`), `:1212-1220`, `:1242-1249`, `:1409-1413`.
  - `packages/web/src/lib/webserial.ts:960-963`; `packages/web/src/lib/si-protocol.ts:1385-1393`.
  - `packages/api/src/routers/control.ts:411-416` (`AUTO_NAMES`), `:758-766`, `:1579`.
- **What is wrong:** the target picker lists every control, including code-less ones the API allows for auto-named kinds (start, finish, crossing point, map issue). `parseInt` of an empty code is NaN, nothing guards it, and `encodeStationCode(NaN)` gives code byte 0, so the station is written as code 0. The result row shows NaN and is marked success. `recordProgramming` gets `programmedCode: NaN`, sent as null and rejected by zod, so no `control_units` row is written and battery and checked state are lost. Auto mode cannot match these controls.
- **Scenario:** an OCAD import has a code-less "Start 1". The operator picks it and couples the start unit: it is reprogrammed to code 0, the UI says success plus a record error, and Controls shows no unit for the start.
- **Fix (S, M with the prompt):** guard in `programStation` before `reader.programControl` when the code is not an integer in 1-1023, adding a translated result row and setting `lastProgrammedSerial` so the 600 ms poll does not re-flag. Make `encodeStationCode` throw on bad input. Exclude crossing and map-issue points from the picker, and prompt for or default a code for code-less start/finish rather than filtering them out. Unit-test a pure `resolveTargetCode(control)` beside `control-programming-payload.ts`.
- **Verdict:** confirmed by code reading and a `node` check of the NaN arithmetic and JSON serialisation; no hardware run. Corrected: `map_exchange` is not auto-named, and the row says NaN, not 0, and success, which is worse. The "31, 32" taking 31 sub-case is already API-19. Medium kept. (reviewer C7)

### WEB-37 Backup readout in Auto mode re-reads and re-posts a station in a loop when the import fails; offline it hangs on "Reading…" and later clears whatever unit is on the stick
- **Area / category:** controls, backup readout; stability (data loss on the offline path).
- **Location:**
  - `packages/web/src/pages/ControlsPage.tsx:1613-1616`, `:1683-1688`: import awaits.
  - `ControlsPage.tsx:1640`, `:1662`, `:1717`: the only writes to `lastReadSerial.current`.
  - `ControlsPage.tsx:1774-1800`, `:1807`: auto-poll, 50 ms tick.
  - `ControlsPage.tsx:1620-1638`, `:1691-1711`; `packages/web/src/lib/webserial.ts:1247-1258`: clear and power-off.
  - `packages/web/src/main.tsx:19-27`: no `networkMode`.
- **What is wrong:** when an import rejects, the catch only sets the error and the next tick sees the same serial as new, so the backup memory is read and posted again while the unit stays on the stick; `setError(null)` at `:1786` makes the message flicker. Both procedures are lease-guarded, so a non-lease-holder fails every time. Offline, the mutation pauses and the panel shows "Reading…" with no hint. When the network returns, clear and power-off run against whatever unit is coupled then, with no serial check.
- **Scenario:** the operator reads 60 controls in Auto mode on a laptop talking to the cloud while the venue box holds the lease; each unit is re-posted until lifted. Variant: with Clear ticked the link drops mid-import, the next unit goes on, the network returns, and the unread unit's backup is erased.
- **Fix (S):** on failure set `lastReadSerial.current = serialNo`, add a failed row with a Retry that works after the unit is lifted (or says to put it back), and keep the error for that serial. After the await, re-probe and compare with `stationData.serialNo` before clear or power-off. Set `networkMode: 'always'` on both mutations. Tests: a rejecting import, and a swapped unit.
- **Verdict:** confirmed in part by code reading; traced, not run. Refuted: "auto-clear and power-off are skipped"; in the same session they run, which is worse (the stale erase). "Runs later" holds only without a reload; after one the mutation is dead (SYNC-25). Server idempotency of repeated imports was not checked. Medium: the erase needs an offline event, Clear and a swap. An SI finding (`05-si-readout-ble.md:93`) touches the same clear calls. (reviewer C8)

### WEB-38 Event page settings: save failures are never shown and the UI keeps the unsaved state
- **Area / category:** event settings; stability.
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:1215-1221`, `:1367-1369`: `updateConfig` and `setCardFee` with no error use.
  - `EventPage.tsx:1231-1236`, `:1379-1388`: one-shot seeding behind an `initialized` ref.
  - `EventPage.tsx:1246-1249`: `saveItems` sets state before `mutate`.
  - `EventPage.tsx:1348-1351`: card fee validation without a message.
  - `EventPage.tsx:1633-1657`: Sheets webhook `setConfig`.
  - `EventPage.tsx:882-884`, `:936`, `:1049`, `:1134`: mapping mutations, outside the error block at `:1104-1111`.
  - `EventPage.tsx:1664-1668`: `handleCopy`.
  - `EventPage.tsx:1616` and `packages/web/src/lib/download-api.ts:8-13`: backup download.
- **What is wrong:** payment methods, Swish, receipts, rental card fee, the Sheets webhook and ROC mappings show no save error, and there is no global mutation error handler. Local state is set before the call and never re-seeded, so a failed save looks saved until remount. An empty or negative fee is silently not sent. `navigator.clipboard.writeText` is unguarded and throws on the documented plain-HTTP LAN setup. The backup download rejects unhandled on non-2xx or network failure, with no pending or failure state.
- **Scenario:** the organiser unticks Invoice and sets the fee to 40 as their session expires; other laptops still offer Invoice at the old fee. Or the pre-event backup gets a 500 with no message.
- **Fix (S):** render each mutation's error next to its fields; on error reset the `initialized` guard and re-seed from a refetched `config.data`; cover both `setRegistrationConfig` components; validate the fee inline; use `navigator.clipboard?.writeText` with a select-the-`<pre>` fallback; catch the backup download, show the message and add a pending state. Component tests for a rejected save.
- **Verdict:** confirmed by code reading and grep. Narrowed: offline, the mutation pauses and applies later (SYNC-25); the silent path is a real error response. "Believes a backup was saved" is overstated: no file appears, but nothing says it failed. Clipboard alone is low. Related: the `06-offline-sync.md:510` entry on the settings refresh during a lease. (reviewer C9)

### WEB-39 Fetch errors render as "empty" or a blank page instead of an error state
- **Area / category:** classes, controls, event, library, trends; stability.
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:36` and `packages/web/src/pages/RegistrationTrendsPage.tsx:242`: return `null` without data.
  - `packages/web/src/pages/ClassesPage.tsx:365-369`, `:692-698`.
  - `packages/web/src/pages/ControlsPage.tsx:322-326`, `:685-691`.
  - `packages/web/src/pages/TracksPage.tsx:117-123`.
  - `packages/web/src/pages/LibraryClassesTab.tsx:108-110`, `packages/web/src/pages/LibraryControlsTab.tsx:121-123`.
- **What is wrong:** none of these queries reads `isError`, and `main.tsx` has no global query error handler. EventPage and the trends page render blank with no retry. Classes and Controls show "No classes" or "No controls" on a failed list, and "Class not found" or "Control not found" for any detail error. Tracks shows its header with 0 routes and an empty body (its own empty text is correctly gated). The library tabs show their empty text while loading and on error. The persisted cache limits this to a cold cache.
- **Scenario:** on a laptop that has never opened this event's Controls page, the API is briefly unreachable and the page says "No controls". An operator about to program stations may conclude the course import is missing.
- **Fix (S):** add a shared `<QueryError query={...} />` with a message and a Retry calling `refetch`, used where `isError && !data`; it must also handle `isPending && fetchStatus === 'paused'` with an offline message, since an offline cold query is neither loading nor errored. Gate empty texts on `isSuccess`; distinguish NOT_FOUND via `error.data?.code` in the two inline details. Component tests for error, paused and empty states.
- **Verdict:** confirmed by code reading of all nine locations and grep; line numbers accurate. Added the paused-query gap in the fix and the narrower Tracks behaviour. The re-import consequence is a guess; the false empty text is real. (reviewer C11)

### WEB-40 Class max time (inline and bulk) uses `parseMeosTime` with no validation or echo of the parsed value
- **Area / category:** classes; functional.
- **Location:**
  - `packages/web/src/pages/ClassesPage.tsx:103-104`: bulk confirm echoes the raw text.
  - `ClassesPage.tsx:108`, `:452-459`: bulk input and parse.
  - `ClassesPage.tsx:881-889`: inline `onBlur`.
  - `packages/shared/src/types.ts:278-287`: `parseMeosTime`.
  - `packages/shared/src/readout.ts:564`: OverMaxTime rule.
- **What is wrong:** both call sites pass raw text to `parseMeosTime`. "2:30" meant as 2 h 30 min is stored as 2 min 30 s. Any single-part input ("150", "2h") gives 0, which removes an existing limit on the inline field. A multi-part input with a non-numeric part ("2:3x") gives NaN, which zod rejects, and neither mutation shows the error. The bulk confirm shows the raw string, not the parsed duration. The server accepts any integer, including negatives. `readout.ts:564` marks OverMaxTime when the running time exceeds a non-zero limit, online and offline.
- **Scenario:** the evening before, the organiser bulk-sets max time "2:30" on 40 classes. On race day essentially every OK runner reads out as over max time.
- **Fix (S):** one helper for duration fields that accepts H:MM[:SS] (or bare minutes, per RES-13's duration parser) and returns null otherwise; show `formatMeosTime(parsed)` in the confirm and under the inline field; refuse null; add `.min(0)` on the server; show mutation errors. Unit-test the helper.
- **Verdict:** confirmed by code reading and a hand trace (RES-13 reproduced the parser). Corrected: "2h" gives 0, not NaN. The reviewer's fix mixed MM:SS and H:MM for two parts; use H:MM here. Raised from low to medium: a natural input gives wrong statuses for a whole event. RES-13 does not list these call sites; related WEB-34. (reviewer C15)

### WEB-41 Editing a start or finish time with an unparseable value silently clears it; HH:MM is read as MM:SS
- **Area / category:** runner inline detail, punch table; functional.
- **Location:**
  - `packages/web/src/components/PunchTable.tsx:630-635`: `TimingRow.saveTime`; `:637-641`: Clear also sends 0.
  - `PunchTable.tsx:371-378`: `ControlRow.saveTime`.
  - `PunchTable.tsx:746-756`, `:319-322`: `AddPunchForm` submit and early close.
  - `packages/shared/src/types.ts:278-287`: `parseMeosTime`.
  - `packages/web/src/components/RunnerInlineDetail.tsx:53-71`, `:334-345`: five mutations, no `onError`.
  - `packages/api/src/routers/runner.ts:201-207`, `:131-133`: 0 accepted and stored.
- **What is wrong:** `TimingRow.saveTime` sends `parseMeosTime(timeInput)` unchecked. Any input without a colon ("12.45.30", "124530", "") gives 0, the same value Clear sends, and the server stores it. NaN input is rejected by zod and the row closes with no message. Two-part input is MM:SS, so "12:45" is 00:12:45; `ControlRow` and `AddPunchForm` guard only against 0 but share that reading. `AddPunchForm` closes and resets before the result is known.
- **Scenario:** an official corrects a finish time on the Runners page, types "12.45.30" and presses Enter. The finish time is erased with no message and the row shows a dash; the old value cannot be recovered from the UI. Typing "12:45" for a start stores a wrong time that looks valid.
- **Fix (S):** add a new strict parser in shared, one with RES-13's `parseClockTime` (HH:MM:SS, HH.MM.SS, HHMMSS; reject NaN, negatives, fractions; one rule for two parts), leaving `parseMeosTime` for its other callers. On null keep the editor open with a red border. Add `onError` to the five mutations; keep `AddPunchForm` open until success (`onAdd` returns a promise). Parser tests and a component test that "12.45.30" + Enter does not call `onUpdateTime(0)`.
- **Verdict:** confirmed by code reading; parser outputs match the existing test and RES-13's reproduction. Narrowed: the erasure shows in the row; "drops out of the results" was not traced; the prefilled value lowers the risk when correcting. Lowered from high to medium: one runner, visible at once. RES-13 shares the root cause; the PunchTable paths and missing `onError` are new. (reviewer D2)

### WEB-42 Standalone kiosk stays on "Reading card, do not remove" when a read produces no readout
- **Area / category:** kiosk; stability.
- **Location:**
  - `packages/web/src/pages/KioskPage.tsx:310-317`: detect effect, returns early on removal.
  - `KioskPage.tsx:321-343`: the only standalone exit from `reading`.
  - `KioskPage.tsx:142-152`: reset timers, the only place `lastProcessedRef` is cleared.
  - `KioskPage.tsx:287-295`: paired mode's `card-removed` handling.
  - `packages/web/src/lib/webserial.ts:637-640`, `packages/web/src/lib/reader-bt/connection.ts:518-526`: no readout emitted.
- **What is wrong:** the detect effect cancels the reset timer and sets `reading`, then ignores the card going back to null. A pulled card emits nothing on USB (empty `finalizeReadout`) or Bluetooth (`CardRemovedError`), so nothing leaves `reading`. A tRPC hang in `storeReadout` has the same effect, since the fetch has no timeout. `lastProcessedRef` survives because its timer was cancelled, so a re-read of the last shown card (same dedup id and action) is rejected.
- **Scenario:** at a quiet standalone finish a runner pulls the card early; the screen shows "Reading card 8001234, do not remove" until another card is read. Variant: card A is shown, B is pulled early, A is inserted again: the screen stays on "Reading card A".
- **Fix (S):** on removal while `reading`, go idle only when no readout for that card is in flight, clearing both refs. Add a 20 s `reading` watchdog that only changes the screen and clears `lastProcessedRef`, so a late result still shows. Clear `lastProcessedRef` when a result screen is left (fixes the variant). Route SI-05's `si:card-read-failed` there. Use a pure reducer (WEB-52) and unit-test detect, removed, idle and A/B/A.
- **Verdict:** confirmed by code reading and the existing `kiosk-standalone-routing.test.ts` (11 pass; it asserts the rejection). Narrowed: the screen heals on any other card or a fresh read of the pulled card, so at a busy finish it is brief; `lastDetectedRef` is not the cause. Not SI-12, SI-17 or SI-32. (reviewer D3)

### WEB-43 Standalone kiosk mode does not do what the docs say: no registration dialog, no receipt printing, a dead setting
- **Area / category:** kiosk; functional, documentation.
- **Location:**
  - `packages/web/src/pages/KioskPage.tsx:334-335`, `:164-173`: registration-waiting and its watchdog.
  - `KioskPage.tsx:349-354`; `packages/web/src/pages/CompetitionShell.tsx:271-275`: print only via the channel and its one subscriber.
  - `KioskPage.tsx:54`, `:550-563`: `writeToCard`.
  - `KioskPage.tsx:44`, `:185-199`, `:435`, `:470`, `:637-659`: dead `card-done` code.
  - `CompetitionShell.tsx:606-655`: `RegistrationDialogProvider`.
  - `docs/system/registration-and-readout.md:611-641`, `:649`, `:679-696`; `docs/guide/race-day.md:59`.
- **What is wrong:** (1) §7e says the registration dialog can be opened in standalone mode, but it exists only inside the shell; an unknown card shows "Registration in progress" for 15 s, then idle. (2) The kiosk never calls `usePrinter`; it only posts `kiosk-print-receipt`, so without an admin tab in the same profile nothing prints. §7f documents that delegation, so the mismatch is §7e ("no admin window needed") and the guide. (3) `writeToCard` is stored and shown but read nowhere. (4) No code sets `card-done`; §7c and §7d describe a step that does not exist.
- **Scenario:** an unregistered runner at a standalone kiosk is told registration is in progress; 15 s later nothing has happened. Finished runners get no receipt though a printer is attached.
- **Fix (M):** for `register` in standalone mode show "Card not registered, go to the registration desk"; print through `usePrinter()` when connected, moving receipt assembly out of `CompetitionShell.tsx:271-300` into a shared helper, with the channel as fallback; remove `writeToCard` (setting, i18n keys, `e2e/kiosk.spec.ts:73-74`, `kiosk-readout.spec.ts:352`) or implement it; delete `card-done` and correct §7c-§7f. Fix SI-03 first.
- **Verdict:** confirmed by code reading and grep; part 2 narrowed on the docs side. Added: the kiosk's `PrinterProvider` auto-connects and may contend with the admin tab for the printer. Medium: optional mode, no data loss. Related SI-03, SYNC-03, SI-32. (reviewer D5)

### WEB-44 A paired-mode kiosk tab opens the granted USB or Bluetooth reader itself and then shows nothing for the cards it reads
- **Area / category:** device manager, kiosk; stability.
- **Location:**
  - `packages/web/src/context/DeviceManager.tsx:728-770`: mount effect reattaches every granted port and Reader BT, with no route or setting check.
  - `DeviceManager.tsx:268-283` with `CompetitionShell.tsx:233`: why the kiosk tab's channel is null.
  - `DeviceManager.tsx:505`: `applyResult` runs in the kiosk tab.
  - `packages/web/src/App.tsx:61`, `:95-96`.
  - `packages/web/src/pages/KioskPage.tsx:310-311`, `:321-322`, `:388-401`.
- **What is wrong:** `DeviceManagerProvider` wraps every route, so the kiosk tab competes for the reader. If it wins with Standalone off, it stores and applies cards online, but both consuming effects return early, its reader button is hidden and nothing is broadcast. The losing tab's attach fails once and never retries. Unregistered cards get no registration dialog anywhere.
- **Scenario:** a browser session restore loads both tabs together, or the kiosk bookmark is opened first. The station beeps, the kiosk stays on "Insert card", the admin tab shows the reader in error. Reloading either tab does not help; the crew must close the kiosk, reconnect in the admin tab, then reopen it.
- **Fix (S):** add an `autoReconnect` switch to the provider, always off on `/:nameId/start-screen` and off on `/:nameId/kiosk` unless Standalone is on; skip both the serial and Reader BT blocks; reattach when Standalone is turned on at runtime. Document that a standalone kiosk and an admin tab still contend. Prefer this to the kiosk consuming its own reader, which leaves the admin tab blind. E2E with mock-webserial: grant a port, open the kiosk with Standalone off, assert the port stays closed.
- **Verdict:** confirmed by code reading; the cross-tab open failure is Chrome behaviour, not reproduced. Narrowed: opening the kiosk from the admin tab, and one-at-a-time reloads, are safe. Added the hard recovery and missing dialog. Medium at the upper end. SI-03 contributes. (reviewer D6)

### WEB-45 Start screen shows "No runners starting" or a frozen list if the one-shot `competition.select` call fails, and can show another competition's cached start list
- **Area / category:** start screen; stability.
- **Location:**
  - `packages/web/src/pages/StartScreenPage.tsx:116-126`: one-shot select and the gated query.
  - `StartScreenPage.tsx:255-258`: static green dot and cached competition name.
  - `StartScreenPage.tsx:428-438`: empty state.
  - `packages/api/src/routers/event.ts:198-225`, `:709-716`.
  - `packages/web/src/pages/KioskPage.tsx:104-124`.
  - `packages/web/src/main.tsx:20-26`, `:78-87`; `packages/web/vite.config.ts:58-80`.
- **What is wrong:** the query is `enabled: selectMutation.isSuccess`, select fires once and mutations do not retry, though select only validates the slug. If it fails, the query never runs and the page shows whatever restored `startScreen` data exists: "No runners" on an empty cache, a frozen list on a same-competition cache. The key has no competition in it and the cache persists 24 h, so any failed or pending fetch can show another competition's list. There is no error or stale indicator.
- **Scenario:** the start laptop reloads during an API restart and select fails once; the board shows a frozen or empty list with a live-looking clock. On day 2 it shows day 1's runners.
- **Fix (S):** enable the query on `!!nameId`; for KioskPage, retry select or source the name elsewhere, since its `onSuccess` and two hooks depend on it. Take staleness from a server timestamp in the payload or exclude the route from the service worker cache, because its NetworkFirst cache returns a 200 and advances `dataUpdatedAt`. Scope the key by adding `nameId` to the response or input; do not use `reset()` on mount.
- **Verdict:** confirmed by code reading. Corrected: the frozen-list outcome, the cross-competition case without a select failure, and that an offline browser pauses rather than fails. Added the service-worker gap in the banner fix. The cache half shares SYNC-19's root cause. (reviewer D8)

### WEB-46 Start screen loses runners at both ends of the list when more than about 13 (768 px) or 20 (1080 px) start in the same minute
- **Area / category:** start screen; functional.
- **Location:**
  - `packages/web/src/pages/StartScreenPage.tsx:179-204`: unit budget and the 18 px floor.
  - `StartScreenPage.tsx:233-238`: root `height: 100vh; overflow: hidden`.
  - `StartScreenPage.tsx:341-355`, `:370`: centred list.
  - `StartScreenPage.tsx:444-473`: uncapped upcoming strip.
- **What is wrong:** below the floor each tile still needs about 42.5 px, so the stack outgrows `main`. The list's `overflow: hidden` clips nothing, since its height is unconstrained; it overflows symmetrically, under the clock (digits overlap names) and the half-transparent footer, and only what passes the root is cut. Slight overflow garbles names; at 40+ they are gone. The heading shows the full count, with no paging or "+N".
- **Scenario:** more than 13 to 20 classes on one minute (the client never passes `classId`), or any mass or chasing start; the names at both ends of the call-up board cannot be read.
- **Fix (M):** measure `main` with a `ResizeObserver` instead of the `minFont * 2.3` budget; when runners do not fit, use 2-3 columns, then rotating pages with "1/3". Add `overflow: hidden` and `minHeight: 0` on `main`, top-align on overflow, and cap the upcoming strip to one line with "+N". Unit-test a pure layout function for 1 to 200 runners at 768 and 1080 px.
- **Verdict:** confirmed in part from code reading and recomputed thresholds; not rendered. Clipping starts at about 14 at 768 px, one later than claimed. Refuted: the mechanism (`overflow: hidden` on the list); the overflow is under the clock and footer, garbled before it is cut. Medium: the paper list is the fallback. Not covered by RES-22. (reviewer D9)

### WEB-47 Start screen downloads the whole start list every 5 seconds; `windowSeconds` is accepted and ignored
- **Area / category:** start screen; performance.
- **Location:**
  - `packages/web/src/pages/StartScreenPage.tsx:122-126`: `refetchInterval: 5000`, no input.
  - `StartScreenPage.tsx:149-164`: only two minute groups used.
  - `packages/api/src/routers/event.ts:709-758`: `windowSeconds` declared at `:713`, unfiltered query with class join at `:721-737`.
  - `packages/web/src/main.tsx:76-87`: no `shouldDehydrateQuery`.
- **What is wrong:** every poll returns every runner with a start time, with a class join, though the page shows only the current and next minute and drives the roll-over from the local clock. Each poll also triggers SYNC-28's whole-cache write.
- **Scenario:** 2,000 runners: about 340-400 KB of JSON per poll per screen, plus a 2,000-row query and serialisation on the event database every 5 s. The Docker stacks gzip `/trpc` JSON, so the wire cost there is roughly 40-70 KB per poll; the 200-250 MB per hour figure holds only without that nginx. On LAN to the venue box the uplink is not involved.
- **Fix (S):** fetch the full list once and re-poll every 30-60 s (or when `counterState.oRunner` moves). A server window needs quantised client-sent bounds in event time, since the server clock is UTC (API-14, RES-06) and `startTime` is zero-time relative, and it blanks the display after 30 minutes offline. Exclude the query from persistence only with a stale indicator (WEB-45). Test the poll interval and grouping.
- **Verdict:** confirmed by code reading and grep. Narrowed: the byte figures are uncompressed, and the claim that a slow link makes the display miss late start-time changes is overstated, since the service worker refreshes its cache when the request completes (SYNC-16). Medium at the upper bound. Related SYNC-28, RES-22, DB-44; WEB-59 covers the cloud image's compression. (reviewer D10; also E8)

### WEB-48 Start screen call-up offset is not saved; a reload puts it back to 3 minutes
- **Area / category:** start screen; stability.
- **Location:**
  - `packages/web/src/pages/StartScreenPage.tsx:101`: `useState(3)`.
  - `StartScreenPage.tsx:294-303`: offset buttons.
  - `StartScreenPage.tsx:216-224`, `:352`: transition effect and opacity.
- **What is wrong:** the offset is plain state with no storage or URL parameter, unlike the kiosk, which persists per competition. Separately, the transition effect updates `prevMinuteRef` only inside its 500 ms timeout, so changing the offset and back within 500 ms leaves `transitioning` true and the list at opacity 0 until the next minute (low on its own).
- **Scenario:** the crew sets the call-up to 5 minutes for a long walk; the laptop reloads and the board calls runners two minutes late, with only the small "⚙ 3m" label showing it.
- **Fix (S):** persist the offset in `localStorage` under `oxygen-start-screen-${nameId}` (validated to 1-5, wrapped in try/catch), optionally with `?offset=`. Set `prevMinuteRef.current = advanceFloorMinute` at once and use the timeout only to clear `transitioning`.
- **Verdict:** confirmed by code reading, grep and a hand trace of the effect; no test (the web package has no DOM test environment). Not in BLD-26 or the zero-time review. (reviewer D11)

### WEB-49 Opening an older card from Recent Cards shows the latest card instead, and the "from reader" banner never clears
- **Area / category:** race-day screens; functional.
- **Location:**
  - `packages/web/src/pages/CardReadout.tsx:27` (`lastCardIdRef` starts `null`)
  - `packages/web/src/pages/CardReadout.tsx:38-46` (effect that copies `currentCard` into the input and runs the 3 s banner timer)
  - `packages/web/src/components/RecentCards.tsx:57`
  - `packages/web/src/hooks/useSearchParam.ts:12-27`
  - `packages/web/src/context/DeviceManager.tsx:341,490,561,592`
- **What is wrong:**
  - `DeviceManagerProvider` wraps the whole app and keeps the last card read for the session. Card Readout is a lazy route that mounts fresh, so on mount the effect sees `currentCard.id !== null`, treats the existing card as a new read and replaces the `?card=N` set by Recent Cards with the latest card number.
  - The banner timer is cleared by the effect's cleanup whenever `currentCard` changes identity (DeviceManager replaces the unresolved entry with a resolved one, same id) or whenever `setCardInput` changes identity, which happens every time the search params change. The effect's own `setCardInput` call therefore cancels the timer, and the banner stays until the page unmounts.
- **Scenario:** cards A, B and C are read while the operator is on the Runners page. To handle A's rental card the operator opens Recent Cards and clicks A. The readout page shows C's runner, and "Mark returned" or "Accept variant" goes to C unless the operator notices the name.
- **Fix (S):** initialise the ref as `useRef(currentCard?.id ?? null)`, or seed it only when a `card` param is present at mount if the menu entry should keep auto-filling the last card. Keep the timer in its own ref, cleared only on unmount or when a new timer starts, and not tied to `currentCard` or `setCardInput` identity. The component test (mount with `?card=111` and a `currentCard` for 222, assert 111; then deliver a new card and assert it switches) needs jsdom and Testing Library added to the web package, or an E2E spec instead.
- **Verdict:** confirmed by code reading, including react-router 7.18.5 `useSearchParams`; a scratch component test could not run because the web package has no DOM test environment. The banner defect is broader than claimed (the `setCardInput` dependency) but cosmetic on its own. Different from SI-17, which concerns a slow earlier card overwriting `currentCard`. (reviewer D12)

### WEB-50 Card Readout and Backup Punches pages show nothing, or "no data", when a query or mutation fails or is paused
- **Area / category:** race-day screens; stability.
- **Location:**
  - `packages/web/src/pages/CardReadout.tsx:49-52`
  - `packages/web/src/pages/CardReadout.tsx:110-130`
  - `packages/web/src/pages/CardReadout.tsx:173-175`
  - `packages/web/src/pages/BackupPunchesPage.tsx:93-103`
  - `packages/web/src/pages/BackupPunchesPage.tsx:189-193`
  - `packages/web/src/pages/BackupPunchesPage.tsx:233-239`
  - `packages/web/src/pages/BackupPunchesPage.tsx:294-307`
  - `packages/web/src/pages/BackupPunchesPage.tsx:363-365`
  - `packages/web/src/main.tsx:19-27`
- **What is wrong:** `CardReadout` renders only a spinner, a not-found box or the result; after the single retry a failed lookup leaves the area under the input empty. `setCardReturned` has no `onError`. `BackupPunchesPage` falls back to `[]` and shows "No backup punches imported" or "No backup readouts imported" for a failed query. `pushBackupPunch` and `pushReadoutBackup` have no `onError`, so a failed push re-enables the button with no message. With the browser offline the default `networkMode: 'online'` pauses the query, which is neither loading nor in error, so both pages show the blank or empty state at once, and a paused mutation keeps the push buttons disabled with no message.
- **Scenario:** the readout desk loses the server for a minute; the operator types a card number not looked up on this device in the last 24 hours and gets an empty page. After the event, on a flaky link, Backup Punches reads "No backup punches imported" and the operator concludes the import was lost.
- **Fix (S):** in `CardReadout` add an error panel with Retry for `readout.isError` and a branch for the paused or pending-not-fetching state. In `BackupPunchesPage` show the empty text only on `isSuccess` and an error or offline panel otherwise. Give the three mutations `onError` with an inline message and show a "waiting for network" state for a paused mutation.
- **Verdict:** confirmed by code reading and grep (no `isError`, `.error` or `onError` in either page, no global error handler). The verifier added the paused-query and paused-mutation cases, which a fix keyed on `isError` alone would miss, and softened the scenario for cards still in the persisted cache. Related to SI-11 and SYNC-25. (reviewer D13)

### WEB-51 Mispunch maps on the desk and in the previews mark skipped controls as missing and correctly punched controls as extra
- **Area / category:** race-day screens; functional.
- **Location:**
  - `packages/web/src/pages/CardReadout.tsx:284-298`
  - `packages/web/src/pages/KioskPage.tsx:817-847`
  - `packages/web/src/components/CardMapPreview.tsx:55-66`
  - `packages/web/src/components/RunnerMapPreview.tsx:47-58`
- **What is wrong:** the kiosk builds `punchStatusByCode` with two rules: an unpunched skipped position (Bad, Optional, BadNoTiming) is not drawn as missing, and an "ok" slot is not overwritten by an extra punch of the same code. `MispunchMap` on the Card Readout page, and the copies in `CardMapPreview` and `RunnerMapPreview`, apply neither rule. The prop type at `CardReadout.tsx:286` drops `positionMode`, although the data passed at `:273` carries it. The text banner and punch table are correct; only the map contradicts them.
- **Scenario:** a control is marked Bad after it was stolen. A runner with one real mispunch comes to the desk: the map shows two red crosses and zooms to include the stolen control. A runner who punched 1,2,3,5,4,5,6 on course 1-6 is OK, but the ordered matcher leaves the first 5 as an extra, so the map draws control 5 orange.
- **Fix (S):** extract one `buildPunchMapInfo(readout)` helper (for example `lib/readout-map.ts`) from the kiosk's `useMemo`, use it at all four sites, and widen the prop type to include `positionMode`. Unit-test both rules.
- **Verdict:** confirmed by code reading and hand traces through the matcher in `packages/shared/src/readout.ts`. The verifier found the two extra copies in the preview components, so the fix must cover four sites, not two. Medium kept at the low end: display only. (reviewer D14)

### WEB-52 Finish Station: Enter can be dropped or applied to another runner, and typed digits are wiped when a slow save returns
- **Area / category:** race-day screens; stability.
- **Location:**
  - `packages/web/src/pages/FinishStation.tsx:42-46`
  - `packages/web/src/pages/FinishStation.tsx:110-118`
  - `packages/web/src/pages/FinishStation.tsx:131-142`
  - `packages/web/src/pages/FinishStation.tsx:153-155`
  - `packages/web/src/pages/FinishStation.tsx:230-234`
  - `packages/web/src/pages/FinishStation.tsx:332`
  - `packages/web/src/lib/offline/projection-reads.ts:163-175`
- **What is wrong:** four defects beside SI-10. (1) Enter acts only if `lookup.data?.found` at that instant; before the lookup resolves it is dropped with no feedback. (2) With the offline-projection flag on (a localStorage opt-in), `useLiveQuery` keeps the previous card's result until the new read resolves, and nothing compares `lookup.data.cardNo` with the input. (3) `onSuccess` and `handleOfflineFinish` clear the input unconditionally. (4) `onError` queues from the current `lookup.data`, not the failed mutation's runner. Also `:332` renders a stray "0" when `runningTime` is 0.
- **Scenario:** a scanner sends "8001234" and Enter within milliseconds: nothing is recorded and nothing says so. On slow Wi-Fi the operator presses Enter for A and types B's number; A's response wipes it. With the flag on, a stale found result (800123 found, then "4" and Enter within the read window, or a pasted number) records the finish on the previous runner.
- **Fix (S-M):** store a pending intent `{cardNo, pressedAt}` on Enter, act when the lookup for that `cardNo` resolves, cancel it when the input changes with a not-found or timeout message. Require `lookup.data.cardNo === parseInt(cardInput, 10)`, also for the panel at `:278`. Clear the input only if it still holds the recorded card. Put `cardNo` and runner name in the mutation variables and queue from them in `onError`. Return `data` from `useLookupByCard` only when `local?.cardNo === cardNo`, reporting loading otherwise. Use `runningTime > 0 &&`. Unit-test the four cases in an extracted handler.
- **Verdict:** confirmed by code reading, including dexie-react-hooks 4.4.0 `useObservable`; no test exists for the page. Part (2) narrowed to stale found results with the flag on; part (4) needs a mid-request drop, since an already-offline mutation is paused and never reaches `onError`. Overlaps SI-10 without duplicating it. (reviewer D15)

### WEB-53 Finish Station overwrites an existing finish time with "now" on one Enter, with only an amber note as warning
- **Area / category:** race-day screens; functional.
- **Location:**
  - `packages/web/src/pages/FinishStation.tsx:212-228`
  - `packages/web/src/pages/FinishStation.tsx:293-297`
  - `packages/web/src/pages/FinishStation.tsx:230-234,302-308`
  - `packages/api/src/routers/race.ts:320-386` (`recordFinish`; update at about `:346-350`)
- **What is wrong:** for a runner who already has a finish, the page shows "already finished HH:MM:SS" in small amber text, but the button and Enter send `recordFinish` with the current time as for anyone else. The server updates `finishTime` with no check, leaves the status OK, and the result list computes the running time from the new value, so the result is wrong and looks valid. The offline path has no check either.
- **Scenario:** the operator mistypes one digit and hits another registered card, a runner who finished 40 minutes ago by readout. That runner's finish becomes now and the running time grows by 40 minutes. The lookup is an exact match, so a truncated number only hits when a card with exactly that shorter number is entered. The `finish.adjusted` entry carries only the new time, so an overwritten manual finish has no other copy.
- **Fix (S):** when the runner has a finish, require a second step ("Replace finish HH:MM:SS with now" in a warning style, plain Enter ignored, or a confirm dialog), also offline. On the server add `allowOverwrite` to `recordFinish`, default false, refusing with a distinct error code so the client can show the confirm step even when its cached `finishTime` is stale. Add an integration test for the refusal and a component test for the confirm step.
- **Verdict:** confirmed by code reading. The prefix-match and "journal has the old value" parts of the scenario were corrected as above. API-13 covers kiosk-key callers only and SI-10 the manual-finish and readout conflict, so this is new. Medium kept. (reviewer D16)

### WEB-54 Race-day screens have almost no tests of their own logic; one unit file tests a parallel copy and one E2E assertion checks a dead setting
- **Area / category:** race-day screens; tests.
- **Location:**
  - `packages/web/src/lib/kiosk-routing.ts:33`
  - `packages/web/src/lib/__tests__/kiosk-routing.test.ts:6`
  - `packages/web/src/context/DeviceManager.tsx:448-481`
  - `packages/web/src/pages/KioskPage.tsx:54,553-560`
  - `packages/web/src/pages/KioskPage.tsx:203-304`
  - `e2e/kiosk.spec.ts:73-74`
  - `packages/web/src/components/PunchTable.tsx:68-90`
- **What is wrong:** `determineKioskScreen` is imported only by its own test. The real decision is implemented inline in `DeviceManager.tsx`, so the tested function is a parallel copy that can drift without any test failing. The kiosk's message handler and timers are inline in `KioskPage` with only E2E coverage. `e2e/kiosk.spec.ts:73` asserts the label of `writeToCard`, a setting that is bound to a checkbox and read nowhere. No unit or component test covers `PunchTable` (`buildInlineRows` is not exported), `FinishStation`, `CardReadout`, `CardNotification` or `BackupPunchesPage`. The start-screen part is already BLD-26.
- **Scenario:** a refactor of the kiosk message handler that breaks the screen sequence passes the unit suite, and the kiosk-routing test keeps passing after `DeviceManager` changes its routing rules.
- **Fix (M):** make `DeviceManager` use `determineKioskScreen`, or delete it and its test. Extract a pure `kioskReducer(state, event)` with timers as events and unit-test it, keeping the kiosk E2E specs as the safety net. Remove the `writeToCard` setting, its i18n keys and the `kiosk.spec.ts:73-74` assertions, or wire it. Add the component tests named in WEB-41, WEB-49 and WEB-52.
- **Verdict:** confirmed by grep and code reading. Refuted and restated: the kiosk does implement the rules, in `DeviceManager`, not in `KioskPage`. The claim that WEB-41, WEB-42, WEB-49 and WEB-52 would each have been caught was not checked. Part (start-screen call-up and the `if (hasNoRunners)` assertion) is already BLD-26; use that fix. Medium kept. (reviewer D18)

### WEB-55 Results, start list and runner tables render every row unvirtualised and re-render all of them on each click, sort and changed refetch
- **Area / category:** results, start lists, dashboard and cross-cutting performance; performance.
- **Location:**
  - `packages/web/src/pages/ResultsPage.tsx:63-69`
  - `packages/web/src/pages/ResultsPage.tsx:99-193`
  - `packages/web/src/pages/StartListPage.tsx:160-203,206-275`
  - `packages/web/src/pages/RunnerManagement.tsx:295-398`
  - `packages/web/src/components/ClubLogo.tsx:30-32`
- **What is wrong:** nothing in the client is virtualised. `lists.resultList` returns every non-removed runner, so Results mounts one inline `<tr>` per runner, each with a `ClubLogo` that has its own `club.logoMap` observer and a `StatusBadge` that calls `useTranslation` (Results and Runners only). Rows are not memoised, and expanded row, sort and filter live in URL params read by the page, so a row click, sort or filter change re-renders every row. A refetch that brings a changed list does the same; an unchanged refetch does not, thanks to structural sharing. Class grouping on Results is rebuilt each render without `useMemo`.
- **Scenario:** speaker laptop on Results at a 2,000-runner event: about 12,000 cells and 2,000 observers; each new finisher, and each invalidation from WEB-14, re-renders the whole table, and clicking a runner for splits re-renders everything first. Not measured.
- **Fix (M):** extract a `React.memo` row with a stable `onClick`, resolve the logo map once per page and pass `eventorId` down, memoise the grouping. Then virtualise (`@tanstack/react-virtual` with sticky class headers) or start with `content-visibility: auto` on class groups. While there, check the logo lookup on Results, since `resultList` already sends the Eventor id as `clubId`.
- **Verdict:** confirmed in part by code reading. Refuted: "every refetch re-renders all rows" (only changed payloads do) and StatusBadge on the start list. The `?? []` new-array point is true but harmless and dropped. Medium kept at the upper edge because it compounds with WEB-14. (reviewer E3)

### WEB-56 Results, start list and dashboard have no error or paused state: a failed load shows "no results" or a blank page, and old data carries no age
- **Area / category:** results, start lists, dashboard and cross-cutting performance; stability.
- **Location:**
  - `packages/web/src/pages/ResultsPage.tsx:87-91,195-199`
  - `packages/web/src/pages/StartListPage.tsx:134-138,277-281`
  - `packages/web/src/pages/CompetitionDashboard.tsx:105-113`
- **What is wrong:** the three pages read only `data` and `isLoading`. After a failed first fetch (`retry: 1`), Results and Start List show "No results found" or "No start list entries", and the dashboard returns `null`, a blank page under the tabs. With `navigator.onLine` false the query is paused rather than failed, so the empty text shows with no error at all. Cached rows (24 h) carry no age marker.
- **Scenario:** the shell has loaded the competition, then the link drops, or the heavy `resultList` returns 500, or the user lacks `results.view`: the page reads "No results found", which looks like data loss. A tablet with no cache and no network does not reach the pages; it sees the shell's connection-error screen.
- **Fix (S):** a shared `QueryState` wrapper with an error panel and Retry, handling `isError` and the paused state (`isPending && fetchStatus === 'paused'`); show the empty state only on `isSuccess && data.length === 0`; replace the dashboard's `return null`. A staleness banner needs a `dataUpdatedAt` threshold or a polling interval to be useful.
- **Verdict:** confirmed in part by code reading. Refuted: the no-cache tablet scenario (the shell blocks it) and "no offline hint" (the header's `SyncStatusIndicator` turns amber offline, though it shows no data age and misses an unreachable server). The stale-leader scenario is mostly a different problem: Results has no `refetchInterval` and is stale even online. `CompetitionDashboard.tsx:18` and `:304` are optional sub-cards and dropped. (reviewer E5)

### WEB-57 Draw timeline: dropping a class later in its own corridor lands one slot too far, and dropping it back in place swaps it with its neighbour
- **Area / category:** results, start lists, dashboard and cross-cutting performance; functional.
- **Location:**
  - `packages/web/src/components/DrawTimeline.tsx:137-148`
  - `packages/web/src/components/DrawPanel.tsx:230-239`
  - `packages/web/src/components/DrawTimeline.tsx:113-124`
  - `packages/web/src/components/DrawTimeline.tsx:33-39`
  - `packages/api/src/draw/optimizer.ts:330-336`
- **What is wrong:** `handleDrop` skips the dragged bar with `continue` but assigns the raw loop index, which still counts it. `handleTimelineReorder` removes the dragged class first and then splices at `targetIndex`, so it expects an index without the dragged class. Forward moves in the same corridor land one slot late; backward and cross-corridor moves are correct. The first class of a corridor cannot be dropped and stay first. The reorder writes hints for every class, so one accidental drop pins all corridors. `handleDragOver` sets new state on every dragover event, and `hoverX`, `originCorridor` and `containerRef` are never read.
- **Scenario:** corridor 1 holds A, B, C. Dropping A between B and C gives [B, C, A]. Dropping A back on itself gives [B, A, C], and the preview is recomputed with new hints the organiser may apply.
- **Fix (S):** compute the index over the bars without the dragged class, and return early when the position is unchanged in the same corridor. Move the computation to `lib/draw-timeline.ts` and unit-test forward, backward, in-place and cross-corridor drops. Set `hoverCorridor` only when it changes and delete the unused state.
- **Verdict:** confirmed by code reading and hand traces; both lists share one order (`drawEngine.ts:229-233`), so nothing compensates. Medium kept at the low end: visible in the preview before anything is stored. The area 04 note lists this drag and drop as not reviewed, so there is no existing id; related to RES-15. (reviewer E7)

### WEB-58 Start station and kiosk pre-start clock is a once-per-second server poll: it shows 00:00:00 until the first answer and freezes when the network drops
- **Area / category:** results, start lists, dashboard and cross-cutting performance; stability.
- **Location:**
  - `packages/web/src/pages/StartStation.tsx:17-19,39,53,113,139-143`
  - `packages/web/src/pages/KioskPage.tsx:1152-1158,1166-1171`
  - `packages/web/src/pages/FinishStation.tsx:36-38,246,257`
  - `packages/api/src/routers/race.ts:87-92`
  - `packages/web/vite.config.ts:65-77`
- **What is wrong:** the clock and countdowns show `race.serverTime.data?.deciseconds ?? 0`, refetched every 1,000 ms (10 s on the Finish Station), with no local ticking. Before the first answer the clock reads 00:00:00 and a countdown is `startTime - 0`, so a runner scanned then sees her start time of day as minutes to go (for example "615m"). On failure React Query keeps the last value, and the service worker's NetworkFirst rule can answer an idle station's request with the cached 200, so the clock freezes either way. Each answer also triggers a full cache persist (SYNC-28).
- **Scenario:** the pre-start tent's Wi-Fi drops for two minutes. The clock stops at 10:14:37 and a runner who scans sees "starts in 5:23" frozen, waits and misses her start.
- **Fix (S):** a `useServerClock()` hook that fetches every 30-60 s, takes the epoch `now` field (not `deciseconds`, which uses the container zone, API-14), computes an offset at the request midpoint, keeps it in a ref and localStorage, and drives the display from a local interval. Reject answers whose `now` predates the request start, which also defeats the cached 200; a URL exclusion does not work with batched paths. Show "clock not synced" after N minutes, and feed the offset to `recordClockSkew` (SYNC-27). Use it on all three pages.
- **Verdict:** confirmed by code reading, not run in a browser. Worse than claimed on the pre-first-answer countdown. The cached-200 path needs an unbatched URL; a batched request simply fails, with the same freeze. Medium kept: the start runs from the start clock. Overlaps SYNC-16, SYNC-27, SYNC-28 and API-14. (reviewer E9)

### WEB-59 The cloud image serves the JS bundle and all tRPC JSON uncompressed
- **Area / category:** results, start lists, dashboard and cross-cutting performance; performance.
- **Location:**
  - `packages/api/src/staticServe.ts:6` (header claims to replicate nginx) and `:31-42` (no `preCompressed`)
  - `docker/nginx.conf:63-66`
  - `docs/ops/deploy-gcp-cloud-run.md:9-10`
- **What is wrong:** the compose stack gets gzip from nginx. The Cloud Run image has no nginx: the API serves the bundle through `@fastify/static` and answers tRPC itself, with no compression plugin, no `onSend` hook and no pre-compressed assets. Only the map-store and course-map routes compress their own payloads. The deploy doc states there is no load balancer in front. Whether Cloud Run's frontend compresses was not confirmed on a live service; public reports suggest it does not.
- **Scenario:** a remote user or an event run directly on the cloud instance loads the dashboard over a phone hotspot and downloads the bundle and every list refetch uncompressed (sizes from WEB-76 and WEB-14, not measured here). Arena stations normally use the venue box, which has nginx.
- **Fix (S):** register `@fastify/compress` scoped to `/trpc` and JSON, excluding every route that sets `Content-Encoding` or serves ranges (map documents, heightfield, DEM COG, course-map graphics), and check streaming responses are not buffered. Emit `.br`/`.gz` in the web build and set `preCompressed: true`, checked with `wildcard: false` and the SPA fallback, keeping those files out of the precache manifest. Update the header comment; add cases to `static-serve.test.ts` and a `/trpc` `content-encoding` assertion. A `curl -I -H 'accept-encoding: gzip'` against the deployed service settles the frontend question.
- **Verdict:** confirmed from code reading and grep; byte figures unverified (no dist). Scenario narrowed to cloud-instance users; medium is the upper bound. Related to MAP-14 (do not double-compress) and BLD-10. (reviewer E10)

---

## Low

### WEB-60 Pressing "Reload" on the update banner in one tab force-reloads every other open tab of the app
- **Area / category:** app shell, state and data layer; stability.
- **Location:**
  - `packages/web/src/hooks/useServiceWorkerUpdate.ts:27-34` (interval, uncaught `update()`)
  - `packages/web/src/hooks/useServiceWorkerUpdate.ts:39-48` (`updateServiceWorker(true)`)
  - `packages/web/src/App.tsx:63-73`
  - `packages/web/vite.config.ts:44-47`
  - `packages/web/node_modules/vite-plugin-pwa/dist/client/build/register.js` (`controlling` listener)
- **What is wrong:** SKIP_WAITING activates the new worker for every controlled tab, and each one that saw the waiting worker reloads through vite-plugin-pwa's `controlling` listener, since no `onNeedReload` is passed. The per-tab decision promised in `vite.config.ts:44-46` holds only per origin. The 60 s `registration.update()` has no catch, giving one unhandled rejection per minute offline.
- **Scenario:** a mid-event cloud deploy; the operator clicks Reload in the secretariat tab, and the kiosk, start screen and a half-typed registration on the same laptop reload and lose in-memory state, and on a weak link each must get through WEB-03 again.
- **Fix (S):** at minimum say "reloads all Oxygen windows on this computer" in the banner. Deferring via `onNeedReload` must be short, because the new worker drops the old precache and lazy chunks can fail in a deferred tab. Catch the `update()` rejection.
- **Verdict:** confirmed by reading vite-plugin-pwa 2.0.0 and workbox-window 7.4.1; not run in a browser. Low kept. (reviewer A7)

### WEB-61 Settings > Maps: download errors are unhandled, the downloaded file stays in the persisted query cache, and rename/delete failures are invisible
- **Area / category:** app shell, state and data layer; engineering.
- **Location:**
  - `packages/web/src/pages/SettingsPage.tsx:422-436`
  - `packages/web/src/pages/SettingsPage.tsx:80-88`
  - `packages/web/src/pages/SettingsPage.tsx:292-297` and `:310`
  - `packages/web/src/pages/SettingsPage.tsx:516-546`
  - `packages/web/src/main.tsx:17-27,78-87`
  - `packages/api/src/routers/clubMap.ts:179-195`
- **What is wrong:** the async download `onClick` has no try/catch, so a failed fetch is an unhandled rejection with no message. `utils.clubMap.download.fetch()` is `fetchQuery`, so `fileDataBase64` stays in the cache for the default 24 h `gcTime` and is written by the persister on every later cache write. Rename closes the input at once and shows no error. Delete renders no `remove.error` and its confirm button is not disabled while pending.
- **Scenario:** an admin downloads a 30 MB OCAD source (possible under the 50 MB body limit): about 40 MB of base64 rides along in each persisted write. A network failure on delete leaves the dialog open with no text; a double click gives an unseen NOT_FOUND.
- **Fix (S):** use the streaming route with `fetchDownload`/`saveBlob`, or at least the vanilla client or `gcTime: 0`; catch and show the error; render `rename.error` and `remove.error`, disable confirm while pending and call `remove.reset()` on open, as `removeVersion` does at `:447`.
- **Verdict:** confirmed in part by code reading; the cache effect is from code, not measured. Refuted: a delete "refused because the map is in use"; `clubMap.remove` cascades versions and never refuses. The base64 download itself is already API-35, DB-30 and MAP-11; the write-everything persister is SYNC-28. (reviewer A10)

### WEB-62 Every visible shell tab polls PostgreSQL statistics every 3 s for a header sparkline
- **Area / category:** app shell, state and data layer; performance.
- **Location:**
  - `packages/web/src/components/DbLoadIndicator.tsx:6,120-129`
  - `packages/web/src/pages/CompetitionShell.tsx:459`
  - `packages/web/src/components/VenueLease.tsx:16-19`
  - `packages/api/src/routers/event.ts:767`
  - `packages/api/src/routers/lease.ts:64-70`
- **What is wrong:** `competition.dbStatus` (a `publicProcedure`) is polled every 3 s whenever the shell is ready and the tab visible, regardless of whether the panel is open or the user may manage the event. `LeaseBadge` polls `lease.status` every 10 s even with no peer configured, and each call runs `getActiveLease`. The panel labels are hard-coded English.
- **Scenario:** 20 devices with a visible shell tab on a shared 4G uplink send about 6.7 requests per second for `dbStatus` alone. Kiosk and start-screen pages do not mount the indicator, so real arenas see less.
- **Fix (S):** slow the poll to 30 s while the panel is closed, or show it only to `event.manage` (polling only while open would leave the header sparkline empty). Slow the lease poll when `peerConfigured` is false and no lease exists, but keep a slow poll or refetch on focus so a forced takeover is still seen. Translate the panel.
- **Verdict:** confirmed in part by code reading. Narrowed to visible shell tabs. The claim that batching with `dbStatus` defeats service-worker cache keying is a general property of batching with no shown failure and is dropped. Low kept. (reviewer A11)

### WEB-63 Small cleanups in the shell layer
- **Area / category:** app shell, state and data layer; engineering.
- **Location:**
  - `packages/web/src/pages/CompetitionSelector.tsx:28-32,197-201`
  - `packages/web/src/components/LanguageSelector.tsx:14-18`
  - `packages/web/src/hooks/useTimeAgo.ts:7-12` with `packages/web/src/lib/format.ts:38`
  - `packages/web/src/components/SyncStatusIndicator.tsx:388`
  - `packages/web/src/components/ErrorBoundary.tsx:30-41`
  - `packages/web/src/context/CapabilitiesContext.tsx:21-25`
  - `packages/web/src/components/VenueLease.tsx:78-79`
  - `packages/api/src/routers/event.ts:625-629`
- **What is wrong:** (a) `CompetitionSelector` declares `selectMutation` and an error box but never calls it. (b) `LanguageSelector` writes `localStorage` without try/catch, so a throw skips setting `documentElement.lang`. (c) For an invalid date `useTimeAgo` renders the raw key `timeAgo_`. (d) Hard-coded English in `SyncStatusIndicator`, `ErrorBoundary` and the `DbLoadIndicator` panel. (e) The capabilities context value and `has` are rebuilt per render (small impact). (f) `VenueLeasePanel` shows the first non-null of three mutation errors, so an old checkout error survives a later successful checkin. (g) `competition.changeWatermarks` has no caller.
- **Fix (S):** delete the selector's dead mutation and the `changeWatermarks` endpoint, but not `competition.select`, which other pages use; guard the storage write; return `''` for an empty key; move strings to `common.json` (en and sv); `useMemo` the context value; `reset()` the other two lease mutations in each `onMutate`.
- **Verdict:** confirmed by code reading and grep; all items are maintenance. Low kept. (reviewer A13)

### WEB-64 Registration name field scans the cached runner database on every keystroke, and the closed dialog keeps its queries subscribed on every shell page
- **Area / category:** registration, runners, cards, clubs and search; performance.
- **Location:**
  - `packages/web/src/components/RegistrationDialog.tsx:494-556` (`suggestions` keyed on `name`)
  - `packages/web/src/components/RegistrationDialog.tsx:476-487` (debounce feeds only the server query)
  - `packages/web/src/components/RegistrationDialog.tsx:79-89`
  - `packages/web/src/components/RegistrationDialog.tsx:762`
  - `packages/web/src/components/RegistrationDialog.tsx:888-896`
  - `packages/web/src/pages/CompetitionShell.tsx:654`
  - `packages/web/src/hooks/useStationSync.ts:36-39`
- **What is wrong:** when the runner dump is cached, each keystroke lower-cases and regex-splits every row until 15 matches are found. The dialog is mounted once in the shell and returns null after all hooks, so its six queries stay subscribed and it re-renders on each `recentCards` change. The club options are rebuilt per render.
- **Scenario:** a scratch benchmark over 150,000 synthetic rows cost 30-50 ms per keystroke for a no-match query in Node; on a slow tablet a rare or mistyped surname costs perhaps 150-300 ms per character. Common prefixes cost nothing. The dump is cached only after a station page ran `useStationSync` or from the persisted cache.
- **Fix (S-M):** pre-compute a lower-cased name array once per dump and drive the search from `useDeferredValue` or a short debounce; memoise the club options. A wrapper/body split stops the closed queries, but check sticky mode and the `pendingCard` flow, which rely on the always-mounted effects.
- **Verdict:** confirmed in part by code reading and a scratch benchmark. Refuted: `cardLookupLocal` costs 1.6 ms and is not a problem; the queries are not kept fresh (no `refetchInterval`). Lowered from medium to low: input jank on rare queries only. (reviewer B17)

### WEB-65 Search parser edge cases change the meaning of a query
- **Area / category:** registration, runners, cards, clubs and search; functional.
- **Location:**
  - `packages/web/src/lib/structured-search/parser.ts:411-441`, `:99-104`, `:521-543`
  - `packages/web/src/components/structured-search/StructuredSearchBar.tsx:224-229`, `:245-264`, `:508-511`
  - `packages/web/src/lib/structured-search/anchors/runner-anchors.ts:151-164`, `:433-453`
- **What is wrong:** (1) a negated group next to `|` is flattened into a plain OR group, on either side: `!(class:H21|class:D21) | club:x` and `club:x | !(...)` both lose the negation. (2) Clicking a pill on a multi-select anchor and clicking outside recommits a wildcard `class:H*` as the quoted literal `"H*"`, which matches nothing. (3) A value containing `"` does not survive serialise and re-parse. (4) `parseTimeValue` reads `10:30` as MM:SS, so `scheduled:>10:30` means after 00:10:30.
- **Scenario:** an operator pastes a `?q=` link with a negated group and gets the excluded classes included, or trusts a class list after merely clicking its pill.
- **Fix (S):** the depth-1 tree cannot express `!(a|b) | c`, so either extend the model or reject the input; pushing a sibling turns OR into AND. Take the multi-select path only for `in` or `eq` atoms. Escape quotes consistently in the lexer, `isFullyQuoted`/`unquote`, `splitList` and `hasTopLevelComma`. Parse H:MM for `scheduled` and `started`; keep MM:SS for `forest`. Add round-trip unit tests for each case.
- **Verdict:** confirmed; all four reproduced in a scratch vitest at parser level, part 2 as a string round trip only. Part 1 is wider than claimed and the reviewer's fix for it was wrong. Related to RES-13. (reviewer B20)

### WEB-66 Cards page: link search queries the server per keystroke, "returned" failures are silent, and the map pane keeps the pre-link state
- **Area / category:** registration, runners, cards, clubs and search; engineering.
- **Location:**
  - `packages/web/src/pages/CardsPage.tsx:381-400`
  - `packages/web/src/pages/CardsPage.tsx:576-592`
  - `packages/web/src/pages/CardsPage.tsx:648-651`
  - `packages/web/src/components/CardMapPreview.tsx:32-35`
  - `packages/api/src/routers/runner.ts:357-361`
- **What is wrong:** `runner.list({ search })` runs for every value of two or more characters with no debounce, each cached for 24 h and each running a whole-event `punch.groupBy` that is only needed with `statusFilter`. `setCardReturned` has no `onError`. Link and unlink do not invalidate `cardReadout.readout`, which `CardMapPreview` uses.
- **Scenario:** typing "Andersson" sends eight queries, with a loading flicker on a slow link. After Unlink the map pane keeps the previous runner's course until refocus or another card write.
- **Fix (S):** debounce 250 ms or filter the cached unfiltered list; add `onError`; call `utils.cardReadout.invalidate()` on link success; skip `punch.groupBy` when no `statusFilter` is set.
- **Verdict:** confirmed in part by code reading. Refuted: results never flicker through stale prefixes; after linking the map shows the unlinked fallback, and a stale course appears only after Unlink and lasts until refocus, not seconds. The Runners page is refreshed by the `counterState` poll. The silent link error is already API-37k. (reviewer B21)

### WEB-67 Event type save invalidates `event.*` queries, but the page reads `competition.*` (different query keys)
- **Area / category:** classes, controls, event settings, library and trends; functional.
- **Location:**
  - `packages/web/src/pages/EventPage.tsx:23`
  - `packages/web/src/pages/EventPage.tsx:159-167`
  - `packages/web/src/pages/EventPage.tsx:178-180`
  - `packages/api/src/routers/index.ts:42-43`
  - `packages/web/src/pages/CompetitionSelector.tsx:27`
- **What is wrong:** `eventRouter` is mounted as both `competition` and `event`. `EventTypeEditor` invalidates `utils.event.list` and `utils.event.dashboard`, the only `event.*` uses in the web app, so neither matches a cached query. After a save `dirty` stays true and Save stays enabled beside the "saved" note. Worse: the editor seeds `useState(event.kind)` once, so a remount from the stale cache shows the old kind, and pressing Save writes it back.
- **Scenario:** an organiser changes Competition to Training and saves; the button stays active; the selector's list shows the old kind until an unrelated refetch.
- **Fix (S):** invalidate `utils.competition.dashboard` and `utils.competition.list`, or `setData` from the mutation result; re-seed local state when `event.kind` changes; consider dropping one alias or a test that the web app uses only one.
- **Verdict:** confirmed in part by code reading and grep. Refuted: no other dashboard consumer reads `event.kind`, so the dashboard does not show the old type. The reviewer's "keep `event.list`" was wrong. (reviewer C10)

### WEB-68 Trends chart shows a too-low cumulative value where entries share a timestamp, and the merge is quadratic
- **Area / category:** classes, controls, event settings, library and trends; functional and performance.
- **Location:**
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:214` (merge loop `:209-231`)
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:264-265`
  - `packages/web/src/lib/registration-trends.ts:49-54`
  - `packages/api/src/routers/registrationTrends.ts:41`
- **What is wrong:** cumulative mode emits one point per entry, and the merge takes `find`'s first, lowest point for a shared x. With k entries on the last timestamp the line ends at total minus k plus 1, and forward-fill carries that value to the right edge. The merge is also O(points squared times series) and Recharts gets one row per distinct timestamp.
- **Scenario:** 2,000 entries with 600 on the final timestamp end at 1,401 against "Dated entries 2000". Entries without a time fall on 12:00 UTC of their date. Usually only a few club entries share a second.
- **Fix (S):** collapse cumulative series to one point per distinct x in `buildSeries`, or extract a pure `mergeSeries` with a per-series `Map` and last-wins. Add a duplicate-timestamp case to `registration-trends.test.ts`.
- **Verdict:** confirmed in part; a scratch vitest reproduced 1401. Refuted: "freezes for seconds"; 2,000 plus two 10,000-entry comparisons merged well under a second. Midnight corrected to noon; the curve should match `datedCount`, not total. Lowered from medium to low. (reviewer C12)

### WEB-69 Club library tabs: forms cleared or closed before the save succeeds, no mutation shows an error, one unhandled rejection
- **Area / category:** classes, controls, event settings, library and trends; stability.
- **Location:**
  - `packages/web/src/pages/LibraryControlsTab.tsx:10-33`, `:64-77`, `:204-215`, `:332-342`, `:412`
  - `packages/web/src/pages/LibraryClassesTab.tsx:72-80`, `:167-188`
  - `packages/web/src/pages/LibraryGroupsTab.tsx:27-32`, `:40-42`, `:293`
- **What is wrong:** `LibraryControlsTab` resets the create-series fields and closes the edit modal right after `mutate`, and renders no error for any of its seven mutations. The add-range submit awaits `mutateAsync` with no try/catch, so a rejection is unhandled; the server validates, so no bad data results. `LibraryClassesTab` renders no `update`/`remove` error and Save is not disabled while pending. `LibraryGroupsTab` renders no `remove`/`removeMember` error.
- **Scenario:** an admin submits a new series after the session expired: the form empties, no series appears, nothing says why.
- **Fix (S):** move resets and closing into `onSuccess`, render `mutation.error?.message` per form, try/catch and validate the range client-side, disable submit while pending.
- **Verdict:** confirmed by code reading and grep. Minor correction: create has no unique-name check, so "duplicate name" is not a cause. (reviewer C13)

### WEB-70 Tests: the "forked" E2E asserts client-only state, and settings persistence and the trends merge are untested
- **Area / category:** classes, controls, event settings, library and trends; tests.
- **Location:**
  - `e2e/classes.spec.ts:177-203`
  - `e2e/event.spec.ts:22-44`
  - `e2e/registration-trends.spec.ts:43-70`
  - `packages/web/vite.config.ts:23-38`
  - `packages/web/src/lib/__tests__/control-order.test.ts:1-38`
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:177-232`
  - `packages/web/src/pages/ClassesPage.tsx:100-117`
- **What is wrong:** the forked test matches text driven by local `selectedIds` and never checks persistence (WEB-09). `event.spec.ts` only checks visibility; nothing saves a payment method, receipt or webhook and reloads, or switches events (WEB-32). The trends spec never adds a comparison and the merge (WEB-68) has no unit test. There is no DOM test environment, so hooks such as `useTableSelection` cannot be driven.
- **Fix (M):** extract `mergeSeries` and `buildBulkClassPatch` as tested pure functions; add E2E for payment save and reload, an A-then-B switch, and one counted `fetchComparison` with the Eventor mock. Rewrite the forked test after the WEB-09 decision. jsdom plus testing-library is an optional dependency choice.
- **Verdict:** confirmed in part by reading. Refuted: the test does not depend on the bug; `rental-cards.spec.ts` saves a card fee; `react-dom/server` tests exist. Lowered from medium to low. (reviewer C14)

### WEB-71 Cleanup: dead code, duplicated thresholds, hard-coded English, poll effects re-created every render
- **Area / category:** classes, controls, event settings, library and trends; engineering.
- **Location:**
  - `packages/web/src/pages/ClassesPage.tsx:126-130,197-206`
  - `packages/web/src/pages/ControlsPage.tsx:569`, `:643-652`, `:1222`, `:1265`, `:1282-1331`, `:1445-1447`, `:1730`, `:1813`, `:1984`
  - `packages/web/src/lib/control-programming-payload.ts:14`
  - `packages/web/src/pages/EventPage.tsx:118`, `:1492`, `:1695`
  - `packages/web/src/pages/RegistrationTrendsPage.tsx:47-52`, `:62-71`, `:563`
- **What is wrong:** `handleDragEnd` builds `updates` and discards it, with no optimistic reorder, so the row snaps back until the refetch. The 2.5 V limit is a literal at `ControlsPage.tsx:1222` and `:1984` instead of `LOW_BATTERY_VOLTS`. `relativeTime`, the clock line, "Active" and "N selected" are untranslated. `programStation` and `readStation` depend on the fresh `useMutation` result object, so the poll effects are re-created every render and an in-flight probe (up to about 550 ms) is dropped. `ClubSyncPanel` ignores `_props.env`. Trends casts URL params unchecked.
- **Fix (S):** delete the dead block and add optimistic `setData`; import the constant; move strings to locale files; hold the latest callbacks in a ref; validate the trends params.
- **Verdict:** confirmed by code reading, including react-query 5.107.1's `useMutation`. The 3.0 V badge tier is a separate warning, not a contradiction; DB-39's server cost was not checked. (reviewer C16)

### WEB-72 Kiosk `ReadoutScreen` sends its own `recordFinish` on first reads, racing the admin tab's `applyResult`
- **Area / category:** race-day screens; stability.
- **Location:**
  - `packages/web/src/pages/KioskPage.tsx:721`, `:731-755`, `:795-798`
  - `packages/web/src/context/DeviceManager.tsx:490`, `:498-509`, `:516-518`
  - `packages/api/src/routers/race.ts:320`, `:346-361`
  - `packages/api/src/routers/cardReadout.ts:830-853`
  - `packages/api/src/trpc.ts:341-347`
- **What is wrong:** `DeviceManager` broadcasts the readout to the kiosk before calling `applyResult`. When `findByCard` answers first with finish 0, the kiosk calls `race.recordFinish`, so two writers update one runner and a `finish.adjusted` entry joins the `result.applied` one. `finishRecordedRef` is set before `mutate` and there is no `onError`, so a failure is silent and not retried. Values agree today, so the row write is a no-op.
- **Scenario:** each first read at a paired kiosk that wins the race adds a journal entry, an extra readout and three refetches. Once SI-01 or SI-10 adds an overwrite guard to `applyResult`, this path bypasses it.
- **Fix (S):** delete the effect and the ref. In paired mode the kiosk's `onSuccess` is its only refetch trigger, so send a kiosk message after `applyResult` (or the offline emit) and invalidate `cardReadout.readout`, `runner.findByCard` and `race.finishReceipt` there, in standalone mode too. Then move `recordFinish` to `race.operate`, closing API-13, and check `authentication.md:213` and `offline-architecture.md`.
- **Verdict:** confirmed by code reading; frequency not measured. Narrowed: only first reads, not "almost every read". The guard bypass is future, not present. Lowered from medium to low. Overlaps API-13 and SI-32. (reviewer D4)

### WEB-73 Backup Punches page renders every backup punch in one table and refetches the whole list after each push
- **Area / category:** race-day screens; performance.
- **Location:**
  - `packages/web/src/pages/BackupPunchesPage.tsx:93-103` (refetch after push, `as unknown as` casts)
  - `packages/web/src/pages/BackupPunchesPage.tsx:107-113` (tab state)
  - `packages/web/src/pages/BackupPunchesPage.tsx:210-243` (one `<tr>` per punch, global `disabled`)
  - `packages/web/src/pages/BackupPunchesPage.tsx:327-382` (readouts tab, same pattern)
  - `packages/api/src/routers/control.ts:1687-1696` (`listAllBackupPunches`, no paging)
- **What is wrong:** `listAllBackupPunches` returns every backup punch of the event with no paging. The page renders every row without virtualisation, and each push calls `refetch()` on the full list while `pushMutation.isPending` disables every row's button with no visual cue. The readouts tab does the same. The casts hide future drift (none today). With no punches, clicking "Punches" does nothing.
- **Scenario:** backup memory from every control of a 2,000-runner event gives about 40,000 rows and 240,000 cells. Each committed filter token and each of 50 pushes freezes the page for seconds.
- **Fix (M):** after a push, patch the row with `setQueryData` (`pushedToPunch: true`); track pending per row id; default to a "needs attention" filter with a render cap, or virtualise; type rows with `inferRouterOutputs`; apply the same to the readouts tab.
- **Verdict:** confirmed in part by code reading. Refuted: filtering does not run per keystroke, only per committed token. The row count is an upper bound; the usual import of a few controls is fine. Lowered from medium to low: slow, but nothing is wrong or lost. (reviewer D17)

### WEB-74 Card notification banner sticks on the Card Readout page and reappears for an already handled card on leaving it
- **Area / category:** race-day screens; engineering.
- **Location:**
  - `packages/web/src/components/CardNotification.tsx:34-44`, `:47-51`, `:57-79`
  - `packages/web/src/components/RecentCards.tsx:53-75`
  - `packages/web/src/context/DeviceManager.tsx:673`
  - `packages/web/src/pages/CardReadout.tsx:31-35`
- **What is wrong:** on entering `/card-readout` the effect cleanup clears the dismiss timer and the effect returns early without hiding, so a visible banner stays there with a stale card. `currentCard` is cleared only in `clearRecentCards`, so leaving Card Readout shows a 10 s banner for the card just handled. A banner dismissed by hand also reappears when the same card's entry is updated. `handleAction` and `RecentCards.handleCardClick` duplicate the same switch.
- **Scenario:** the operator handles a card on Card Readout and goes to Runners; a "View readout" banner for that card slides down.
- **Fix (S):** hide when `onCardPage` becomes true; remember the last shown or suppressed card id and show only for a new id, keeping a path for same-id updates; clear the timer only on unmount, new show and hide; share one `openCardAction` helper.
- **Verdict:** confirmed by code reading (no jsdom in `packages/web`). The reviewer's "remove the second effect" is wrong once shows are id-gated. Contradicts the clean verdict in `05-si-readout-ble.md:473`; distinct from SI-17. (reviewer D19)

### WEB-75 Kiosk idle animation caches whatever `/si-read.svg` returns and occasionally restarts on a parent render
- **Area / category:** race-day screens; engineering.
- **Location:**
  - `packages/web/src/components/SiCardAnimation.tsx:77-86`, `:88-90`, `:106-110`
  - `packages/web/src/pages/KioskPage.tsx:37`
- **What is wrong:** the fetch checks neither `r.ok` nor the body, caches it in `rawSvgCache` and injects it with `dangerouslySetInnerHTML`; a rejected fetch is never retried. nginx's `try_files ... /index.html` returns the app shell with 200 for a missing file, which renders as nothing. `getTimeSerial()` in render changes the HTML each second, so a re-render restarts the animation. `KioskPage.tsx:37` parses an E2E `localStorage` key unguarded; a bad value gives a 0 ms watchdog.
- **Scenario:** the SVG is missing from a deploy: the kiosk shows no animation for the session.
- **Fix (S):** check `r.ok` and a leading `<svg` before caching; stamp a constant placeholder and run the interval callback once immediately; guard the parse and fall back to 15000.
- **Verdict:** confirmed in part by code reading. Refuted: the service worker fallback does not apply to `fetch`, and the file is precached. Restarts are occasional, not on every page render, since the clock lives in `IdleContent`. Not an injection risk. (reviewer D20)

### WEB-76 About 1.34 MB of JavaScript loads before any page, because both locales and the whole `@oxygen/shared` barrel are in the entry graph
- **Area / category:** results, start lists, dashboard and cross-cutting performance; performance.
- **Location:**
  - `packages/web/vite.config.ts:188-211`
  - `packages/web/src/i18n/i18n.ts:4-51`
  - `packages/shared/src/index.ts:13-20`
  - `packages/shared/package.json` (exports `./src/*`, no `sideEffects`)
  - `packages/web/src/lib/trpc-links.ts:16`
  - `packages/web/src/context/DeviceManager.tsx:35`
- **What is wrong:** `index.html` preloads the entry (509 kB), the `src` barrel chunk (428 kB, with proj4, zod and the importers) and three vendor chunks: about 1.34 MB raw, 430 kB gzip. i18n statically imports 24 namespaces for both languages (306 kB). The service worker precaches 4.46 MB.
- **Scenario:** a volunteer opens the kiosk URL on a phone for the first time and waits for the map stack before first paint.
- **Fix (M):** load locale namespaces lazily (`resourcesToBackend`); import small helpers through the existing deep paths, such as `@oxygen/shared/src/cloud-ownership.js`; check the chunk list that `src-*.js` leaves the preloads.
- **Verdict:** confirmed by a rerun `vite build`, numbers matched. `"sideEffects": false` alone is unproven. First visit only. The cloud compression part (WEB-59) was not checked. (reviewer E11)

### WEB-77 Dashboard "Finished" card links to a dead `?status=` parameter and opens Results unfiltered
- **Area / category:** results, start lists, dashboard and cross-cutting performance; functional.
- **Location:**
  - `packages/web/src/pages/CompetitionDashboard.tsx:150`
  - `packages/web/src/hooks/useStructuredSearch.ts:33-36` (reads only `q`), `:51-56` (deletes legacy params)
- **What is wrong:** the Finished card navigates to `results?status=finished`. Nothing reads `status`; `useStructuredSearch` reads only `q` and deletes `status` as a legacy parameter. The other two cards use `runners?q=status:...`. Results therefore lists every runner, including those not started.
- **Scenario:** an official clicks Finished (1,412) during the missing-runner check and gets all 2,000 runners.
- **Fix (S):** change the link to `results?q=status:finished`; extend the dashboard test in `e2e/phase3.spec.ts` to click Finished and assert the filtered count.
- **Verdict:** confirmed by code reading and a grep for `status` param readers. Part 2, the "in forest" / "not started" Results filters that depend on fields `resultList` never sets, is already CRS-042. The link defect is not reported elsewhere; RES-25 is a different defect on the same page. Low: the data shown is correct, only unfiltered. (reviewer E12)

### WEB-78 Dashboard status counts have no refresh interval, so "in the forest" lags as start times pass; `classOptions` memo misses `t`
- **Area / category:** results, start lists, dashboard and cross-cutting performance; functional.
- **Location:**
  - `packages/web/src/pages/CompetitionDashboard.tsx:76`, `:81-88`
  - `packages/api/src/routers/event.ts:400-401`, `:436-446`
  - `packages/web/src/hooks/useExternalChanges.ts:10-20`
- **What is wrong:** `competition.dashboard` splits "not started" and "in the forest" by the server clock but has no `refetchInterval`. It refreshes on focus or when `useExternalChanges` invalidates `competition`, which happens for runner, class, course, club, team or event changes, not for `oPunch` or `oCard`. Start and radio punches do not move the counts. `classOptions` calls `t` but depends only on `dashboard.data`, so the count suffix keeps the old language.
- **Scenario:** a wall display before the first finisher, with drawn starts and no runner edits, shows "In the forest" at 0 while 300 runners are out.
- **Fix (S):** add `refetchInterval: 60_000` to the dashboard query on this page; add `t` to the memo deps.
- **Verdict:** confirmed in part by code reading. Overstated: any runner write anywhere refreshes the counts, and hidden tabs do not poll. The progress bar's 15 s whole-event aggregation is already DB-44 (CRS-076 covers its fallback). Driving it from the change poll would need `course` added to the `oCard`/`oPunch` mapping. (reviewer E13)

### WEB-79 No unit tests for list sorting, grouping, refresh or timeline drops, and the E2E list checks cannot detect wrong order or places
- **Area / category:** results, start lists, dashboard and cross-cutting performance; tests.
- **Location:**
  - `e2e/phase2.spec.ts:199-213` (Start List), `:216-234` (Results)
  - `e2e/draw.spec.ts:72-86`
  - `packages/web/src/lib/__tests__/draw-timeline.test.ts:33-75`
  - `packages/web/src/components/DrawTimeline.tsx:~197` (`handleDrop`)
  - `packages/web/src/hooks/useSort.ts:50-118`
  - `packages/web/src/hooks/useExternalChanges.ts:33-88`
  - `packages/web/src/pages/ResultsPage.tsx:63-69`
- **What is wrong:** no test touches `useSort`, `useExternalChanges`, the inline class grouping or `handleDrop`. The Results and Start List E2E tests assert only that headings, column titles and one badge are visible; the draw spec never drags. Filter anchors do have tests.
- **Scenario:** the class-order defect (CRS-064), WEB-57 and WEB-77 exist on main with a green suite.
- **Fix (M):** extract and test pure `groupByClass`, `dropIndex`, `routersToInvalidate` and the sort; assert the first rows of a seeded class in E2E; add one drag to `draw.spec.ts`.
- **Verdict:** confirmed by file listing and reading. CRS-047 is the API-side counterpart. (reviewer E14)

---

## Not reviewed, or could not be verified

- No browser, E2E, integration or hardware run. `packages/web` has no DOM test environment (no jsdom or testing-library), so every component behaviour (registration dialog, runner editor, kiosk, start screen, error boundary) is from code reading. Scratch vitests covered library behaviour (TanStack Query, the persister) and pure functions only. WEB-23 (local runner-database auto-fill not re-running online) in particular should be confirmed in a browser with the dump cached before it is fixed.
- Performance was reasoned, not profiled: the render cost of the 2,000-row tables (WEB-28, WEB-55), payload sizes (estimated from returned fields), server cost of `resultList` and `controlCompletionStatus`, and the start-screen layout numbers (computed in Node from the page's own arithmetic). Only the bundle sizes in WEB-76 were measured, from one `vite build`.
- WEB-59: whether Google's front end compresses responses for the deployed Cloud Run service was not checked against a live instance. WEB-60 (cross-tab reload) rests on the `vite-plugin-pwa` client source and Workbox behaviour from knowledge. The service-worker NetworkFirst cache masking WEB-04 on same-origin production was reasoned, not measured.
- WEB-44 relies on Web Serial's one-open-per-port rule and was not exercised; WEB-72's actual interleaving of `recordFinish` and `applyResult` was not measured; WEB-36 was not tried against a station.
- Whether `authEnabled` is on for venue-box deployments (it decides how bad WEB-04 is) was not checked. How free-text clubs (no Eventor id) get into an event was not traced; WEB-06 and WEB-10 need at least one.
- Read only in part, because other areas own them: `DeviceManager.tsx` readout pipeline (area 05), `CompetitionSelector.tsx` after line 700 and the Eventor panels of `EventPage.tsx` (area 07), the LiveResults panel (EVT-20), ProgrammingPanel and ReadoutPanel SI semantics (area 05), `PrinterContext` and receipt building (area 09), `MapPanel`/`MapSlot` and WebGL context release over hundreds of kiosk readouts (area 08).
- Not read: the unit tests under `lib/__tests__` for the shell helpers (existence and size only, so no judgement of their quality), the 2,000 lines of structured-search unit tests (grepped only), most E2E spec bodies (titles and the blocks cited), and `docs/system/*.md` beyond the sections cited.
- The time-of-day dependence of the hard-coded `'11'` in `e2e/phase3.spec.ts:130` was looked at but not settled.

**Found clean:**
- Shell helpers: `lib/trpc-links.ts`, `app-update.ts`, `legacy-caches.ts`, `html-api-response.ts`, `version-book.ts`, `undo-stack.ts`, `format.ts`, `event-list.ts`, `shell-tabs.ts`, `kiosk-routing.ts`, `kiosk-standalone-routing.ts`, `kiosk-key.ts`, `file-to-base64.ts`, `feature-flags.ts`, `performance-mode.ts`, `download-api.ts` (object URL revoked).
- Hooks `useLocalStorage`, `useMediaQuery`, `useOnlineStatus`, `usePageVisible`, `useSearchParam`, `useSort`, `useTableSelection`, `useStructuredSearch`, `useStatusLabels`, `useBuildInfo`, `useVersionCheck`: listeners and timers cleaned up, no stale closures.
- `PrinterContext`, `RegistrationDialogContext`, `UsersAdminPanel`, `MaintenancePanel`, `ForbiddenPane`, `UserChip`, `ClockSkewBanner`, `BuildInfoLine`, `AccessDeniedPage`, `ReaderConnectionDialog` (UI), `OtherVariantBanner`, `NorthLinesBadge`, `ComparisonPickerDialog` (one untranslated string), `ControlDescriptionEditor` (its `dangerouslySetInnerHTML` takes only bundled IOF SVG), `GraphicPicker`, `HeightDataPanel`, `NewTemplateForm`, `ControlStatusHelp`.
- `kiosk-channel.ts` (no BroadcastChannel leak), `RecentCards` (capped at 20), the kiosk's timers, ResizeObserver and AudioContext: no leak over long runs apart from query-cache growth (WEB-02, SYNC-28).
- Pure libraries with tests: `registration-class-filter.ts`, `club-logo.ts`, `control-*.ts`, `template-picker.ts`, `graphics-picker.ts`, `draw-timeline.ts`, structured-search `filter.ts` and `edit-ops.ts`.
- i18n: en and sv have identical key sets in all 24 namespaces; `escapeValue: false` is safe because output goes through React text nodes.
- Security: no secrets in the bundle (only `VITE_API_URL`), no `dangerouslySetInnerHTML` on user data, no unsafe file handling. Two tabs on different competitions send correctly separated requests (header and service-worker cache URL come from each tab's path); the only cross-tab leak is the shared persisted cache (WEB-01, SYNC-19).
- The structured search bar keeps typing local, so the 2,000-row filter runs only when a token is committed. All routes and pages are lazy, the `manualChunks` rule matches pnpm paths, and the print worker and fonts are excluded from precache as intended.
- PR 254's one-line `EventPage.tsx` change (new `pushCourse` sync row) is fine as UI; both locale keys exist.

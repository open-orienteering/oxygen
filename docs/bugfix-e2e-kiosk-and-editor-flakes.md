# Bugfix: kiosk and course-editor E2E flakes under sharded load

## Symptom

Three tests each failed once in a full sharded run on 2026-10-19 and
passed when their spec was re-run alone:

| Test | Failure |
|------|---------|
| `kiosk-readout.spec.ts` "re-reading card with punches after registration shows readout" (shard 2) | "Test timeout of 30000ms exceeded" with `page.waitForResponse` for `cardReadout.applyResult` still pending |
| `rental-cards.spec.ts` "should show rental card banner on kiosk readout" (shard 3) | kiosk tab did not show "Insert your SI card" within 10 s |
| `course-editor.spec.ts` "inline-edit a control code from the course panel" (shard 1) | `editor-seq-row` count stayed 0 for 15 s after "Add to course" |

A fourth, `courses.spec.ts` "should warn and skip positions when a .ppen
belongs to another map", failed in two of the verification runs listed below
and in the October dependency sweep's run. It has the same cause as the
course-editor one and is fixed with it.

None of them reproduced on an idle machine (`--repeat-each 5` of the
three specs: 140/140) or with Chromium's CPU throttled ×6. They need
the real load of four shards. Diagnostic full runs used
`--trace=retain-on-failure` (with `=`: a bare `retain-on-failure` is
taken as a file filter and the run silently goes unsharded).

## Cause 1 — tRPC batching hides responses from URL matching

The web client uses `httpBatchLink`: calls issued in the same tick share
one request, `/trpc/a,b,c?batch=1`. The kiosk specs waited with

```ts
page.waitForResponse((r) => r.url().includes("/trpc/cardReadout.readout") && r.status() === 200)
```

which matches only when the procedure is *first* in the batch. A loaded
run reproduced it in "MP readout shows missing punch" (the same helper
and pattern as the reported test), with the same error shape as the
original failure: "Test timeout of 30000ms exceeded. Error:
page.waitForResponse: Test timeout of 30000ms exceeded." — the test
budget ran out while a URL-matched wait was still pending, not a slow
call. The trace shows the admin's readout
leaving as

```
GET /trpc/competition.dashboard,competition.getRegistrationConfig,competition.counterState,
         competition.dbStatus,competition.getCardFee,club.list,cardReadout.readout   200
POST /trpc/cardReadout.applyResult                                                  200
```

The test had just created the runner through the API. That bumped the
`oRunner` counter, the 5 s `competition.counterState` poll
(`useExternalChanges`) invalidated the competition/runner queries, and
their refetch landed in the same tick as the readout. Both calls
succeeded, the kiosk showed the result, and the test waited 30 s for a
response it had already received. Which await times out (readout or
applyResult) depends on which call the background batch catches.
`competition.dbStatus`, polled independently, batches with the readout
the same way (seen as `cardReadout.readout,competition.dbStatus` in a
probe run, where the order happened to be harmless).

`rental-cards.spec.ts` also armed its `competition.setCardFee` wait
*after* the blur that fires the mutation.

## Cause 2 — a cold kiosk tab has a tight budget

The kiosk tests open the kiosk in a second tab of the admin's context.
Against the Vite dev server that tab fetches and evaluates the
unbundled app before the lazily loaded kiosk route renders: ~230
requests (app shell, 94 shared-package modules, 44 locale files).
Source modules are served `no-cache`, so the admin tab having loaded
the same modules doesn't help. Measured time to "Insert your SI card":

| Condition | Time |
|-----------|------|
| idle machine, renderer CPU ×6 | 1.3–1.5 s |
| four-shard full run | 1.3–6.2 s |
| A11 run 2026-10-19 (failure) | > 10 s |

`registration-dialog.spec.ts` already gave the identical two-tab setup
20 s; `kiosk-readout` and `rental-cards` gave it 10 s. Lazy-loading the
kiosk's map panel was tried and cut only 24 of the ~230 requests
(≈5 %), so the app was left as is.

## Cause 3 — post-write list refreshes on a loaded database

Course editor and course import show the result of a write only after
a `course.list` refetch. In the ppen trace (shard 2, just after a map
upload) trivial queries took seconds: `competition.dbStatus` 3.7 s,
`lease.status` 3.0 s, `course.importCourses` 4.3 s. An event-loop
monitor preloaded into every Node process (`NODE_OPTIONS=--import`)
showed the API's event loop staying responsive, so the API was waiting
on the shared `:5433` Postgres, not blocked.

The counter poll makes it worse. A write bumps the event's counter, so
the next `counterState` poll invalidates that router. The editor or
importer has already started its own refetch, which carries the new
data, and React Query's default `cancelRefetch` drops it and starts
again:

```
96.6 s  GET course.list,…                  (would land 100.1 s with 10 courses)
99.2 s  counterState poll → invalidate     cancels it, refetches
101.6 s new course.list lands              — assertion deadline was 101.75 s
```

The editor's "Add to course" assertion gave the click, `course.update`,
a refetch and a possible restart one 15 s budget. The course-editor
failure was not reproduced in four loaded runs. It failed with no
server error, which fits this latency rather than a rejected write.

The Playwright worker processes also stall for 2–4 s, but almost always
right before the first test of a spec file (spec compilation and
setup), so they don't explain mid-file failures.

## Fix

- `e2e/helpers/trpc.ts` — `waitForTrpc(page, "router.procedure")`
  parses the comma-separated procedure list of a batched URL and
  resolves only when that call's slot in the body holds a `result`
  (a mixed batch answers 207, so HTTP status alone can't tell).
  It replaces every `url.includes("/trpc/…")` wait in `kiosk-readout`,
  `rental-cards`, `registration-dialog` and `webserial`, and the
  `setCardFee` wait is now armed before the blur.
- `e2e/helpers/kiosk.ts` — `openKioskTab(context, nameId)` with
  `KIOSK_TAB_READY_TIMEOUT = 20_000`, used by `kiosk-readout`,
  `rental-cards` and `registration-dialog`. The standalone kiosk tests
  use the same constant.
- "re-reading card with punches" waited for the reader with
  `reader-status`, which is visible whether the reader is idle or
  reading, so the wait did nothing. It now waits for the kiosk to show
  the first read's outcome ("Registration in progress") before the card
  is re-read, like the sibling clean-card test.
- `course-editor.spec.ts` — every "Add to course" click now awaits its
  `course.update` response before asserting the sequence row. The 15 s
  row budget then covers only the refetch, and a click that never
  reaches the server fails at the wait with the procedure name instead
  of as "0 rows".
- `courses.spec.ts` (ppen on another map) — the post-import course
  count gets 15 s, enough for a poll-induced refetch restart under load.
- AGENTS.md §12 — rules for `waitForTrpc` and `openKioskTab`.

## Regression test

`e2e/trpc-batch-matching.spec.ts` serves batched tRPC responses from a
`page.route` (no app state needed) and asserts that:

- the procedure list of a batched URL is parsed in order;
- a procedure that is *not first* in its batch is matched, and the
  pre-fix predicate (`includes("/trpc/cardReadout.readout")`) would
  not match it;
- a 207 batch where the awaited call errored does not resolve the wait;
- the successful call of a mixed 207 batch does.

## Verification (2026-10-19/20, all under `scripts/with-verify-lock.sh`)

| Run | Result |
|-----|--------|
| 3 flaky specs `--repeat-each 5`, before the fix, idle machine | 140/140 |
| full sharded run, before the fix | kiosk-readout "MP readout" failed (the batching trace above) |
| full sharded run, kiosk fixes only | kiosk specs pass; courses ppen failed (trace above) |
| full sharded run + event-loop monitor | courses ppen failed again; API loop responsive |
| touched specs + regression spec `--repeat-each 3` | 203/204, one failure is new flake 1 below |
| final full sharded run | all touched specs pass; one failure is new flake 2 below |

Two flakes surfaced during verification that are unrelated to these
fixes and are left as follow-ups:

1. `course-editor.spec.ts` "renders automatic circle slits…" — after
   clicking the Course Editor tab the page was pure white (`#fff`, not
   the slate-50 loading spinner, not the ErrorBoundary) for 10 s. Seen
   once in three repeats, never in a full run. No trace was captured.
   Editing docs or E2E files during a run was ruled out as a reload
   trigger.
2. `structured-search-or.spec.ts` "typing class:foo|class:bar…" —
   `readRunnerCount` read the baseline as 0 before the runner list had
   loaded, so `expect(filtered).toBeLessThan(baseline)` failed.

## Not changed (follow-ups)

- **Test Postgres durability.** `docker-compose.test.yml` runs the shared
  `:5433` container with default durability settings, used by four
  shards' tile writes, reseeds and integration tests at once.
  `fsync=off` / `synchronous_commit=off` for this throwaway instance
  would likely remove most of the multi-second latency. Recreating the
  container affects every worktree, so it needs coordinating.
- **`useExternalChanges` cancels the page's own fresh refetch.** It
  invalidates with React Query's default `cancelRefetch: true`, so after
  your own write the poll restarts a refetch that already has the new
  data. On a slow production database this delays your own edits in the
  UI by one round trip. Skipping the cancel risks keeping data from a
  fetch that started before an external write, so it needs a design
  decision rather than a one-line change.

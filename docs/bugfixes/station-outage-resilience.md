# Bugfix: a station went down for the whole outage although its data was cached

Review package 9 of the November 2026 full code review
(findings WEB-03, WEB-04, SYNC-11, SYNC-16,
WEB-02, WEB-15). Technical description: `docs/system/offline-architecture.md`
"Station resilience".

## Symptoms

The common arena failure is "Wi-Fi connected, node unreachable" (the venue
box reboots, the uplink drops): the browser still says it is online.

- **WEB-03.** Re-opening an event during the outage (a reload, or back to the
  event list and in again) spun on "Reconnecting session…" or "Loading
  event…" for good, or dead-ended on "Connection error", although the runner
  list, the dashboard and the outbox were on the device. The cache was used
  only when the page itself had loaded while `navigator.onLine` was false;
  after an `offline` event the `competition.select` mutation paused and
  never settled.
- **WEB-04.** A failed background refetch of `users.me` (for example when the
  tab became visible again) replaced the whole app with a spinner and then
  reloaded the page, with auth on or off. A half-filled registration was
  lost, and after the reload the shell could not open the event (WEB-03).
- **SYNC-11.** A drain that failed (no answer, a 5xx, an HTML page from a
  proxy) was not retried until something else happened: a new entry, the
  browser going offline and online, or a manual sync. Queued card reads sat
  behind an amber count. The push had no timeout either, so a request to a
  node that went away could hang.
- **SYNC-16.** The service worker answered `/trpc/*` GETs NetworkFirst with a
  3 s timeout from a 24 h cache, as an ordinary 200. On a slow link after the
  race, the readout lookup got the pre-start answer from before the start, so
  no result was applied and nothing was queued.
- **WEB-02.** The kiosk readout screen printed a receipt from cached rows of
  an earlier read of the same card number (`runner.findByCard` keyed by card
  number only, persisted for 24 h): a returning runner on day 2 got day 1's
  runner id, and the receipt of whoever has that id today printed.
- **WEB-15.** One error boundary for the whole app: a page that threw took
  down the shell (header, tabs, card notifications, an open registration);
  "Try again" could not recover a failed lazy chunk; a throw in a provider
  had no boundary at all.

## Fix

- **SYNC-16** (`packages/web/vite.config.ts`, `lib/legacy-caches.ts`): the
  `trpc-api` and `api-misc` runtime routes are removed and their caches are
  deleted at start. Offline reads come from the persisted per-event query
  cache alone. The readout lookup after a store (`DeviceManager`) gives up
  after 8 s and resolves locally, as an unreachable server does.
- **WEB-03** (`pages/CompetitionShell.tsx`, `lib/shell-entry.ts`): the shell
  opens from the cached dashboard at once and runs `select` in the background
  with `networkMode: "always"`. `NOT_FOUND` and `UNAUTHORIZED`/`FORBIDDEN`
  close it; any other failure keeps it open in cached mode and retries (2 s
  doubling to 30 s, on `online`, on becoming visible). Without a cache a
  "Cannot reach the server" page retries the same way and offers Retry and
  Reload. A late answer for an earlier event is ignored. The kiosk and start
  screen use the event's cache as soon as it is claimed. Cached capabilities
  no longer fail open after a failed refetch.
- **WEB-04** (`context/CurrentUserContext.tsx`, `lib/current-user-state.ts`,
  `lib/session-probe.ts`, `App.tsx`): the last known identity keeps the app
  mounted (also after a reload, from `localStorage`); the gate spins only
  when nothing is known. A probe that does not follow redirects tells an
  expired session from an unreachable server. Unreachable never reloads;
  expired shows a banner over a page in use and reloads by itself (guarded)
  only when nothing is open. `users.me` is retried every 15 s while failing.
- **SYNC-11** (`lib/offline/auto-drain.ts`, `lib/offline/sync.ts`,
  `hooks/useEventQueue.ts`, `lib/trpc.ts`, `lib/trpc-links.ts`): the drain
  reports its outcome; "retry" (no answer, or a server error) schedules
  another run with backoff while online and pending. Visibility and an
  active-node change retry at once. The push has a 60 s timeout, which
  counts as a network failure. The 2 s pending-count `console.log` is gone.
- **WEB-02** (`pages/KioskPage.tsx`, `lib/kiosk-print.ts`,
  `lib/offline/cache-scope.ts`, `main.tsx`): auto-print needs answers fetched
  successfully after the readout screen opened (a failed refetch over a
  cached row does not count); one automatic print per read, also when the
  read's screen remounts; the three per-card queries are no longer
  persisted.
- **WEB-15** (`components/ErrorBoundary.tsx`, `lib/error-recovery.ts`): a
  boundary around the shell's routed pages (reset by the first route
  segment), one per kiosk read, one per kiosk/start-screen route and one
  outermost around the providers. Translated fallback; a failed chunk
  offers Reload, at most twice per five minutes per tab.

## Behaviour changes to know about

- The kiosk no longer auto-prints from cached rows. With the server
  unreachable it prints no receipt (it could not before either: the admin tab
  fetches the receipt from the server). Finish Station receipts are unchanged.
- An installed PWA that wakes with an expired IAP cookie and a page open now
  shows a "Your sign-in has expired" banner with Reload instead of reloading
  itself. It still reloads by itself (at most twice per five minutes) when
  nothing can be shown: no identity was ever known on the device, or the
  event has no cached data. The probe's IAP
  classification (an opaque redirect, or an HTML / 401 answer) has not been
  checked against a live IAP deployment yet: see the follow-ups.

## Tests

- Unit (`packages/web/src/lib/__tests__/`): `shell-entry`, `current-user-state`,
  `session-probe`, `backoff`, `auto-drain` (retry), `offline-sync` (drain
  outcome), `trpc-links` (timeout), `kiosk-print`, `cache-scope`
  (`isPersistableQuery`), `error-recovery`, `legacy-caches`.
- E2E: `e2e/station-outage.spec.ts` (reload during an outage opens from cache
  and reconnects; re-entry after going offline; retry page without a cache;
  a failed drain retries by itself), `e2e/kiosk-readout.spec.ts` (a re-read
  card prints its current runner's receipt), `e2e/error-paths.spec.ts` (a
  throwing page and a failed chunk stay inside the page), and
  `e2e/outage.preview.spec.ts` on the preview stack (no tRPC cache; a reload
  with `/trpc` unreachable opens the event from the persisted cache). All of
  these fail on the code before the fix.

Follow-ups: [station-outage-followups.md](station-outage-followups.md).

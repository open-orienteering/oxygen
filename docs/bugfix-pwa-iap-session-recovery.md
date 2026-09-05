# Bugfix: PWA "Event not found" after dormancy (expired IAP)

## Symptoms

An installed Oxygen PWA left idle for a while (phone locked, tab backgrounded)
would wake to a full-screen **"Event not found"** for the event that was open.
A manual browser reload fixed it immediately. The event still existed; the
failure was not a real `NOT_FOUND`.

## Root cause

Production sits behind Google Identity-Aware Proxy. When the IAP cookie
expires, same-origin `/trpc` fetches are redirected to `accounts.google.com`
and fail in the browser as a CORS `TypeError: Failed to fetch` — a
**network-class** error with **no** tRPC `data.code`.

`CompetitionShell` treated **any** `competition.select` failure while
`!ready` as "Event not found". Separately, `CurrentUserProvider` defaulted
`authEnabled` to `false` when `users.me` failed the same way, which skipped
the access gate and let the shell render the false not-found state.

Nothing retried the select, and only a full document navigation refreshes
the IAP cookie — matching the observed "reload fixes it instantly".

## Fix

1. **`packages/web/src/lib/session-recovery.ts`** — classify network-class
   vs `NOT_FOUND` errors; guard `location.reload()` with a sessionStorage
   timestamp so a genuine outage cannot loop.
2. **`CompetitionShell`** — show "Event not found" only for `NOT_FOUND`;
   on network-class failure while online, show **Reconnecting…**, retry
   select once, then attempt a guarded reload. On `visibilitychange` →
   visible while still failed, remutate select (dormant-PWA wake-up).
3. **`CurrentUserProvider`** — network-class `users.me` failures keep
   `authEnabled` assumed on and `isLoading` true, then refetch / guarded
   reload instead of flipping auth off.

## Tests

- Unit: `packages/web/src/lib/__tests__/session-recovery.test.ts`
- E2E: `e2e/session-recovery.spec.ts` (abort `competition.select`, assert
  reconnecting UI, restore route, assert recovery without manual reload)

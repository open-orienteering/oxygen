# Performance: polling endpoints and per-request auth round trips

**Date:** 2026-09-24
**Context:** follow-up sweep after
[bugfix-map-tile-cold-render-cloud-timeouts.md](bugfix-map-tile-cold-render-cloud-timeouts.md).
Cloud Run request logs since 2026-09-10 (requests ≥ 0.5 s, tiles
excluded) were grouped by endpoint; the recurring entries were all
polls or per-request plumbing, not user actions.

The scarce resource on the cloud deployment is Cloud SQL
(`db-f1-micro`, ~22 usable connections, non-trivial per-query latency
through the connector). Everything below trades sequential round trips
for single statements or for not asking at all.

## What changed

| Endpoint / path | Before | After |
|---|---|---|
| `competition.counterState` (every 5 s per tab) | 9 sequential queries — one `MAX(updated_at)` per table in a loop, plus punches, events and a Prisma aggregate | 1 statement with scalar subselects |
| `competition.dbStatus` (every 3 s per tab, public) | 3 queries including `pg_database_size()` each time | 1 statement; database size memoised for 60 s (`ttl-memo.ts`) |
| `assertRestAccess` + route handler | Guard resolved the event, handler resolved it again; `countFinishedRunners` on every authenticated request | Guard returns the `EventRef`; handlers reuse it. The finished-runner count runs only when it can change the capability set (`finishedCountMatters`) |
| `/api/maps/:nameId/window.png` | Full print-window rasterisation outside the render semaphore | Shares `renderGate()` with tiles; refused with `503 Retry-After` when the queue is full |
| `course.controlCompletionStatus` (every 15 s) | Loaded every classed runner and every card's full `punches_raw` for the event | Scoped to the requested course's runners and to the cards those runners carry; one regex per control instead of one per runner per code |

### Why the finished-runner count is usually redundant

`resolveEventCapabilities` adds `event.view` / `results.view` /
`courses.view` for every signed-in user once the event is *completed*,
and completion is `date < today || finishedRunners > 0`. The count is
therefore irrelevant when the date is already in the past, or when the
user's grants already include all three capabilities — which is every
club member with a view role. Only a user without those grants, on a
current or future event, still triggers the count. Semantics are
unchanged; `permissions.test.ts` covers the decision table.

### REST guard contract

`assertRestAccess()` now returns `EventRef | null` instead of `boolean`.
Existing `if (!(await assertRestAccess(...)))` call sites keep working;
new handlers should take the returned event rather than looking the slug
up again. Pass `event:` when the handler had to resolve it first (the
tile-progress poll does, because an unknown event is not an error
there).

## Verification

- `permissions.test.ts` — `finishedCountMatters` decision table.
- `ttl-memo.test.ts` — TTL, shared in-flight computation, failures not cached.
- `integration/event.test.ts` — `counterState` returns all nine legacy
  keys; `oClub` ignores removed runners while `oRunner` does not.
- `integration/control-completion.test.ts` — course-scoped vs. aggregate
  counting, direct course assignment overriding the class course,
  alternate punch codes, removed / unclassed runners, cards nobody
  carries. The same suite passes against the previous implementation, so
  the narrowing changed nothing observable.
- `integration/map-tiles.test.ts`, `integration/course-maps.test.ts` —
  routes through the changed guard (404 / 200 / 503 paths).

## Not changed, and why

- `/api/version`, `/sw.js`, first `users.me` at 4–12 s: instance cold
  start (Node + Prisma + Cloud SQL connector handshake). Only
  `--min-instances=1` removes it.
- `lease.status` every 10 s: two indexed reads; its slow tail tracks
  instance saturation, not the query.
- `identityFromRequest` still looks the user up per request. Caching
  identity is an auth decision, not a performance one.
- `maps.pdf` still fetches the full event row (needs `name` /
  `organizerName`); it is a one-off export.

# Station outage resilience: what package 9 left out

Review package 9 ([station-outage-resilience.md](station-outage-resilience.md))
fixed the six findings it lists. These parts of the reviewers' suggestions
were left out on purpose, or need a check that cannot be made in the cloud.

- **Check the session probe against a live IAP deployment.** The probe
  (`lib/session-probe.ts`) reads an opaque redirect under `redirect:
  "manual"`, an HTML answer, or a non-JSON 401/403 as "expired". That is how
  Google IAP behaves as far as we know, but it was not tried against the
  Cloud Run deployment with an expired cookie. If IAP answers some other way,
  the effect is only that the "sign-in expired" banner does not show; the
  Reload button on the retry page and a reload by hand still work.
- **SYNC-25: the global mutation network mode.** Only `competition.select`
  runs with `networkMode: "always"`. The global mutation default and whether
  paused mutations should be persisted at all are SYNC-25's.
- **SYNC-11 extras.** No "retry after any successful tRPC call" (it needs a
  link-level hook; the 30 s cap makes it unnecessary) and no red state after
  N consecutive server failures (the `server` blocked reason already shows
  in the sync panel).
- **A fetch timeout on the main React tRPC client.** Only the drain's push
  (20 s) and the readout lookup after a store (8 s) have one. A global timeout
  would cut large uploads and the runner database dump.
- **`cardReadout.applyResult` after a readout has no timeout.** If the
  network dies between the lookup and the apply, the apply can hang until the
  browser gives up; it then queues `result.applied` as before.
- **Global `error` / `unhandledrejection` listeners and `vite:preloadError`.**
  Not added: there is no client-log endpoint to send them to, and preventing
  Vite's preload error would hide the failure from the boundary that now
  offers Reload.
- **Error states on list pages with a cold cache** (the rest of WEB-01), the
  24 h persist `maxAge` on in-session switches, and a DOM test setup for the
  web package (WEB-16).
- **Two drainers in one browser profile** (a kiosk tab and an admin tab):
  each runs its own retry timer. The per-competition lock in `sync.ts` only
  covers one tab; the server's idempotent ingest keeps a double send safe.

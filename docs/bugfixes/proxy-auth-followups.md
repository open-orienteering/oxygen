# Proxy-mode authorisation: follow-ups left out of package 20

What [proxy-auth-and-svg-xss.md](proxy-auth-and-svg-xss.md) did not do, and why.

- **Per-event checkout token (API-25).** With `AUTH_MODE=off` on a venue box
  anyone on the LAN can check an event out, and the cloud's lease surface is
  guarded by one instance-wide `SYNC_SHARED_SECRET`. Scoping the secret to an
  event needs a column (a migration), so it is its own package.
- **Forwarded-user attribution.** A forwarded write's journal `actor_id` is
  null: the call is the node's. Carrying the box user's id to the cloud
  would need a signed claim, not a header.
- **Stored SVG rows.** Graphics already stored are not re-validated with the
  new rules, and resvg is given the stored bytes without a render-time guard.
  A one-off scan of `graphics` and a check before rasterising would close it.
- **App-wide security headers.** The SPA has no CSP and nginx sends no
  security headers; only the API's `nosniff` and the graphic routes' CSP are
  set.
- **Rate limits.** Eventor-backed calls (any member can trigger them) have no
  rate limit, and `clubMemberCache` has no eviction.
- **`eventor.importEvent`** is open to any member (it creates an event; the
  creator becomes its Event admin). API-36 part (3), the two-event id sweep,
  API-30 (`tracks.deleteRoute`) and API-37b (`clubMap.setRotation`) track
  elsewhere; the club-wide mutations any member keeps are listed in the
  integration sweep.
- **REST uploads are not forwarded from a venue** (map and graphic uploads
  go to the box's own API).
- **A forwarded write that times out may have landed** on the cloud; the box
  says "unreachable" and the user retries. Cloud-owned writes are idempotent
  in practice, but it is not guaranteed.
- **A kiosk-key-only device** still gets `UNAUTHORIZED` from `runner.list` and
  the other `useStationSync` prefetches that need a user; only the runner dump
  was removed from its list.
- **Real IAP behaviour.** Whether IAP answers an unauthenticated programmatic
  call with a 302 or a 401 was not observed; both are handled (a 3xx or a
  non-JSON body is `CLOUD_AUTH`).
- **Forbidden text in SVG comments or `<metadata>`** is refused rather than
  stripped (a false positive for a file that merely mentions `<script`).

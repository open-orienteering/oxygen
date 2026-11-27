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
- **One instance-wide secret means a node id is a claim, not proof.** A box
  that knows `SYNC_SHARED_SECRET` can send another box's node id and act on
  that box's checked-out events. A per-event checkout token (see the first
  item) closes both.
- **`syncRunnerDb` single-flight is per API process.** With several Cloud Run
  instances two syncs can run at once; a Postgres advisory lock would make it
  cluster-wide.
- **Local gate on an auth-off box.** A venue box with login off trusts every
  LAN device to forward cloud-owned edits as the box, like every other local
  write; only a box with login on checks its caller (signed in, and a non-empty
  capability set on the local copy, which it also sends upstream).
- **A node with the secret but no lease passes authed-level procedures.** A
  forward with the right secret and a node id is admitted by `authedProcedure`
  whether or not the node holds a lease, so `classPreset`, `controlSeries`, the
  club map rename and Eventor browsing accept it. It holds no event
  capability without the lease. Narrowing this needs a per-procedure review
  (or the per-event checkout token above).
- **Store the canonical serialisation** instead of the raw upload bytes, so
  what is stored, served and rendered is one validated document (the raw route
  still serves the uploaded bytes under the sandbox CSP today).
- **Run `analyseSvg` in the print worker with a timeout.** It runs on the API
  main thread at upload; a very large or deeply nested document is bounded only
  by the 8 MiB cap and the nesting limit.
- **`reframeSvg` does not handle a prefixed root** (`<s:svg>`): the window
  wrapper and the trim step give up on such a document (a window falls back to
  cutting a whole raster; trim leaves it as uploaded).
- **A box with login off forwards the event header as sent**: it does not
  resolve the event locally or answer 400 for an unknown one (that check runs
  only with login on). The cloud's lease-holder rule still limits what the
  forward can touch.
- **CSS comments inside an unquoted `url()`**: comments are stripped before the
  `url(` scan, so `url(/*)*/#x)` reads as `#x` while a browser reads a
  same-origin relative target. No route to another host was found; the raw
  route is sandboxed and resvg does not fetch. Scan `url(` before stripping.
- **Canonical SVG can be a few times larger than the upload**: escaping in the
  re-serialisation (`"` to `&quot;`, newlines in attributes) gives up to about
  6x on adversarial input, bounded by the 8 MiB SVG limit. Validation is
  linear but runs on the main thread; moving `analyseSvg` into the worker
  (above) also covers this.

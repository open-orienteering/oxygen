# Bugfix: map import failed with `Unexpected token '<', "<html><hea"...`

## Symptom

Uploading a real OCAD map (`Nackareservatet 2023-03-29.ocd`, ~36 MB) failed
in the UI with:

```
Unexpected token '<', "<html><hea"... is not valid JSON
```

The same file had imported before. The tRPC client always `JSON.parse()`s
the response, so any HTML body — IAP login page, nginx 413/50x, or the SPA
`index.html` — becomes that exact SyntaxError.

## What was actually going on

Two independent regressions stacked.

### 1. `events.kind_custom` shipped without being applied

The editable event-type work added `events.kind_custom` to `schema.prisma`
and a migration, and the running Docker API was rebuilt against that
Prisma client. The migration was never applied to the shared dev database.

Every `competition.list` / `competition.select` then threw:

```
The column `events.kind_custom` does not exist in the current database.
```

The event shell treated that as a failed select, so the map panel was
unreachable. Apply the pending migration (`pnpm --filter @oxygen/api exec
prisma migrate deploy`) before retrying an import on a stack that already
has the new client.

### 2. HTML bodies were not classified as API failures

Even when the event opened, a `/trpc` call that received HTML (expired
IAP cookie returning a login page, nginx's default 413/502/504 page, or a
service-worker navigation fallback serving `index.html`) crashed inside
the tRPC parser instead of showing a useful error.

The IAP session-recovery path only matched `Failed to fetch` / CORS
network errors. Same-origin HTML login pages never triggered a reload.

A 36 MB `.ocd` becomes ~50 MB of base64 JSON — under the 50 MiB Fastify /
nginx limit, but over Cloud Run's 32 MiB HTTP/1 request cap. On Cloud Run
that limit is enforced by the GFE as an HTML error page, which is the
same parse failure.

The file itself is valid: a direct `POST /trpc/course.uploadMap` of this
blob succeeds in ~4 s against the local API.

## Fix

1. Apply the `kind_custom` migration so event select/list work again.
2. **`html-api-response.ts`** — inspect non-JSON tRPC responses and throw
   a readable `TypeError` (size / gateway / session) before `JSON.parse`.
3. **`session-recovery.ts`** — treat the HTML-as-JSON SyntaxError as a
   session-class failure so an IAP login page reloads the document.
4. **Service worker** — `navigateFallbackDenylist` for `/trpc`, `/api`,
   and `/health` so Workbox cannot serve `index.html` for API URLs.
5. **nginx** — 413 / 502 / 504 return JSON, not the default HTML page.
6. **Competition shell** — surface the underlying select error for
   non-`NOT_FOUND` failures so a missing column is not a silent
   "connection error".

## Tests

- Unit: `packages/web/src/lib/__tests__/html-api-response.test.ts`
- Unit: `packages/web/src/lib/__tests__/session-recovery.test.ts`
  (HTML-as-JSON is a network-class error)

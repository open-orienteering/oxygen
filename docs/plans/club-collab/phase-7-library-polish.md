# Phase 7 — Library & Visibility Polish

Depends on: phase 4 (permissions/club groups) and phase 5 (library page,
club map files). Independent of phases 8 and 9.

## Goal

Four small, user-reported gaps from the first review of phases 4–6:

1. Adding a member to a club group fails with "No invited user with that
   email" and gives no path forward — admins should be able to invite the
   user inline, and everyone else should learn where invites happen.
2. "Uploaded by: Unknown" appears on club maps when auth is off — noise
   with no information; hide it in that mode.
3. The maps tab is a text-only list — add a rendered preview thumbnail
   per map.
4. The event selector never shows who owns an event — surface the
   creator.

## Current state (verified)

- `users.invite` (`packages/api/src/routers/users.ts`) is an
  `adminProcedure` taking `{ email, displayName?, isAdmin? }`, surfaced
  only on `/admin/users` (`UsersAdminPage.tsx`). There is no invite
  email/token flow — invite = insert into the invite-only `users` table.
- `permission.addClubGroupMember` (`packages/api/src/routers/permission.ts`)
  is `adminProcedure`, input `{ groupId, userEmail }`, throws `NOT_FOUND`
  "No invited user with that email" for unknown emails. The Groups tab UI
  is `packages/web/src/pages/LibraryGroupsTab.tsx`.
- `clubMap.list` already returns `uploader { email, displayName } | null`;
  `LibraryPage.tsx` renders "Uploaded by: Unknown" when null. With
  `AUTH_MODE=off` `ctx.user` is always null so every upload is null.
  The client knows the auth mode via `useCurrentUser().authEnabled`
  (`packages/web/src/context/CurrentUserContext.tsx`).
- Map rendering: `packages/api/src/map-tiles.ts` does
  `readOcad(buffer)` → `ocadToSvg(ocadFile, { document })` (JSDOM) →
  `new Resvg(svg.outerHTML, { fitTo, background: "white" })` → PNG.
  `@resvg/resvg-js`, `sharp`, `jsdom`, `ocad2geojson` are all existing
  api deps, lazy-imported. `club_map_files` has no preview column.
- REST image serving patterns: `/api/club-logo/:eventorId` (open, inline
  in `index.ts`) and `/api/map-tile/...` (guarded by `assertRestAccess`
  in `restGuard.ts` — **event-scoped**, cannot be reused for club-level
  assets). `restGuard.ts` has a private `identityFromRequest(req)` that
  resolves the proxy-header user; browsers send those headers on `<img>`
  requests too (the proxy injects them), so header auth works for images.
- `competition.list` (`packages/api/src/routers/event.ts` `list`) returns
  `EventInfo & { canManage }`. Event creation grants the creator the
  system Event admin role (`grantSystemGroup`, `SYSTEM_GROUP_IDS.eventAdmin`)
  with `grantedBy = ctx.user.id`. No owner is exposed anywhere;
  `CompetitionSelector.tsx` shows name/date/nameId/badges only.

## 7.1 Invite-and-add from the Groups tab

No API change needed — compose the two existing procedures.

`LibraryGroupsTab.tsx`:

- When `addClubGroupMember` fails with `NOT_FOUND`, keep the error text
  but, when the caller can invite (`!authEnabled || user?.isAdmin` from
  `useCurrentUser()` — matches server behavior since `adminProcedure`
  passes through when auth is off), also render an inline
  "Invite <email> and add" button (`data-testid="group-invite-and-add"`).
  Clicking it calls `users.invite({ email })` then retries
  `addClubGroupMember` (tolerate `CONFLICT` from a concurrent invite),
  then invalidates `permission.clubGroups`.
- Below the member-add input, always show a static hint: "Members must be
  invited users — manage invitations under Users admin" with a link to
  `/admin/users` (visible to admins only; non-admins get the hint text
  without the link since the page would reject them).

i18n (`library` namespace, both locales): `groups.inviteAndAdd`,
`groups.inviteHint`, `groups.inviteHintLink`.

## 7.2 Uploaded-by display

`LibraryPage.tsx` maps tab: render the "Uploaded by" line only when
`useCurrentUser().authEnabled` is true. When true and `uploader` is null,
keep the current "Unknown" fallback (pre-auth uploads). No API change.

## 7.3 Club map preview thumbnails

### Data model

Migration `YYYYMMDDHHMMSS_club_map_preview`:

```sql
ALTER TABLE oxygen.club_map_files ADD COLUMN preview_png BYTEA;
```

Prisma: `previewPng Bytes? @map("preview_png")` on `ClubMapFile`.

### API

New file `packages/api/src/club-map-preview.ts`:

```ts
/** OCAD buffer → PNG preview, `maxWidth` px wide. Null when the file
 *  cannot be parsed/rendered (upload must still succeed). */
export async function renderOcadPreview(
  buffer: Buffer,
  maxWidth = 512,
): Promise<Buffer | null>
```

Implementation mirrors `doPreRenderMap` in `map-tiles.ts` but stops at one
small raster: lazy-import `ocad2geojson`/`jsdom`/`@resvg/resvg-js`,
`readOcad` → `ocadToSvg` → `new Resvg(svg.outerHTML, { fitTo: { mode:
"width", value: maxWidth }, background: "white" })` → `resvg.render()`
→ `.asPng()` (Resvg emits PNG directly; sharp not needed here). Wrap in
try/catch → null, log at warn.

- `clubMap.upload` (`packages/api/src/routers/clubMap.ts`): after
  metadata parse, `previewPng: await renderOcadPreview(buffer) ?? undefined`.
- New route `GET /api/club-map-preview/:id` registered via
  `registerClubMapPreviewRoute(server)` (new export from
  `club-map-preview.ts`, called in `index.ts` next to
  `registerMapTileRoutes`):
  - Guard: new `assertClubRestAccess(req, reply)` in `restGuard.ts` —
    allow when auth is off; otherwise resolve the user with the existing
    `identityFromRequest` (make it internal-shared, not exported from the
    package) and require non-null, else 401. No capability check — any
    invited user may see the library, same policy as `clubMap.list`.
  - Lazy backfill: if `previewPng` is null, render from `fileData`,
    persist, serve. Render still null → 404.
  - Reply: `image/png`, `Cache-Control: private, max-age=3600`.

### Web

`LibraryPage.tsx` maps tab: thumbnail per row,
`<img src={`/api/club-map-preview/${id}`} data-testid="club-map-preview">`,
fixed height (~5rem, `object-contain`, rounded border), hidden via
`onError` (parse-failed maps). No lightbox/enlarge in this phase.

## 7.4 Event owner in the listing

- `packages/shared/src/types.ts`: add `owner?: string` to `EventInfo`
  (display name of the creator; absent when unknown).
- `event.list`: one extra query — earliest Event-admin grant per listed
  event:

```ts
const ownerGrants = await prisma().eventPermission.findMany({
  where: {
    eventId: { in: rows.map((r) => r.id) },
    groupId: SYSTEM_GROUP_IDS.eventAdmin,
    userId: { not: null },
  },
  orderBy: { createdAt: "asc" },
  include: { user: { select: { displayName: true } } },
});
// first row per eventId wins
```

  Map `owner` into the returned objects. Auth-off events have no grants →
  `owner` stays undefined; nothing shown.
- `CompetitionSelector.tsx`: small muted line/badge with the owner name
  (`data-testid="event-owner"`), only when `owner` is set.

## Tests (write first)

- **Unit** (api): `renderOcadPreview` against the synthetic fixture
  `e2e/test.ocd` — returns a PNG buffer (magic bytes `89 50 4E 47`) with
  width ≤ 512; garbage input → null. Put in
  `packages/api/src/__tests__/club-map-preview.test.ts`.
- **Integration** (`packages/api/src/__tests__/integration/`):
  - `club-maps.test.ts`: upload stores non-null `preview_png`; simulate a
    legacy row (`previewPng: null` via direct prisma update) and verify
    the backfill path helper persists on next render (test the exported
    backfill function directly rather than HTTP).
  - `permissions.test.ts`: unknown email → `addClubGroupMember` rejects
    NOT_FOUND; after `users.invite` the same call succeeds (compose
    exactly what the UI does).
  - `event` list: create event as an invited user (caller helper with
    user ctx) → `list` returns `owner` = that user's displayName; second
    user granted Event admin later does not displace the original owner.
- **E2E** (extend `e2e/club-map-library.spec.ts` + `e2e/permissions.spec.ts`):
  library maps tab shows the preview `<img>` and it loads (naturalWidth
  > 0) after uploading `test.ocd`; Groups tab: add unknown email → hint +
  "Invite and add" button appears → click → member listed. (Auth off in
  E2E ⇒ invite affordance visible.)

## Documentation

`docs/club-library.md`: preview thumbnails, invite-and-add flow.
`docs/authentication.md`: pointer from club groups to `/admin/users`
invites. `docs/features.md`: event owner in selector, map previews.

## Acceptance criteria

1. Unknown email in Groups tab offers invite-and-add (admin/auth-off) and
   always explains where invites live.
2. "Uploaded by" hidden when auth is off; unchanged otherwise.
3. Every club map shows a rendered thumbnail; uploads keep working for
   unparseable files (no thumbnail, no error).
4. Events created by an invited user show that user in the selector.
5. Full §6 checklist passes.

## Out of scope

- Invite emails/notifications (invite remains a DB insert).
- Preview lightbox/zoom, re-render on demand, previews for event
  (non-library) maps.
- Owner transfer or owner-based filtering.

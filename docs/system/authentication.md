# Authentication

Oxygen does not store passwords. When identity is enabled, a **trusted reverse
proxy** (oauth2-proxy, Cloudflare Access, GCP IAP) authenticates the browser
and injects the user's email as an HTTP header. Oxygen looks that email up in
an invite-only `users` table.

The identity header is **only trustworthy if the proxy strips inbound copies**.
If a client can set `X-Forwarded-Email` themselves, they can impersonate any
invited user. Put Oxygen behind a proxy that overwrites (or drops) that header
on every request.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUTH_MODE` | `off` | `off`: no gating (legacy). `proxy`: read `AUTH_HEADER`. `dev`: fixed `AUTH_DEV_EMAIL`, auto-provisioned as an instance admin. |
| `AUTH_HEADER` | `x-forwarded-email` | Header carrying the authenticated email. Fastify lowercases header names. |
| `AUTH_DEV_EMAIL` | `dev@localhost` | Identity used in `dev` mode. |
| `OXYGEN_ADMIN_EMAILS` | empty | Comma-separated bootstrap admins. On every request with that identity Oxygen guarantees an active admin row — creating it (display name = email local part) or promoting and reactivating an existing one. Grant-only: dropping an email never demotes. |
| `AUTH_AUTO_PROVISION` | unset (off) | `member` / `on` / `true` / `1`: create an active non-admin user for any authenticated email that is not yet in `users`. IAP (or the proxy) is then the allowlist; Oxygen still assigns admin and event roles. Leave unset for invite-only. |

Header parsing: trim, lowercase; if the value contains `:`, take the substring
after the **last** `:` (GCP IAP sends `accounts.google.com:user@example.com`).
Values that do not look like `local@domain` are treated as unauthenticated.

See `packages/api/.env.example`.

## Modes

### `AUTH_MODE=off` (default)

`ctx.user` is always null. tRPC procedures do not require a user. The web app
does not show a user chip or access-denied page. Use this until the proxy is
wired, and typically on LAN venue boxes that do not terminate SSO.

### `AUTH_MODE=proxy`

Every request except `users.me`, health/version, and kiosk/start-screen
pages (which still render without an invite) is gated at the tRPC layer once
`eventProcedure` / `authedProcedure` run. Unknown emails get `UNAUTHORIZED`
from event-scoped procedures unless `AUTH_AUTO_PROVISION` is on, in which
case they are created as members on first sight. The UI shows **Access denied**
for every route except `/:nameId/kiosk` and `/:nameId/start-screen` when there
is no identity, or when the account exists but is deactivated. Those
public pages require a valid kiosk key (`?k=` / `x-kiosk-key`) when no
invited user is present.

Bootstrap: put the first operator in `OXYGEN_ADMIN_EMAILS`. They can promote
everyone else from **Settings → Users** (`/settings?tab=users`).

`OXYGEN_ADMIN_EMAILS` is the break-glass path, so it is reconciled on every
resolve rather than only at row creation — otherwise an account that already
exists (a restored dump, or a member auto-provisioned before the variable was
set) could never be promoted by it, and setting it would silently do nothing.
It only ever grants: an email you remove keeps whatever the Users page says,
and admins granted in the UI are never touched. To revoke a bootstrap admin,
take them out of the variable *and* clear the flag in **Settings → Users** —
otherwise the next request restores it.

### `AUTH_MODE=dev`

Always resolve `AUTH_DEV_EMAIL` (default `dev@localhost`) and create that row
as an admin if missing. Convenient for `pnpm dev` without a proxy. Do not use
in production.

## Proxy snippets

### oauth2-proxy

Run oauth2-proxy in front of the API (or nginx) with `--set-xauthrequest` /
email pass-through so `X-Forwarded-Email` is set from the IdP. Configure
`--reverse-proxy` and **do not** honour a client-supplied `X-Forwarded-Email`.

Example flags (adapt to your IdP):

```
--upstream=http://127.0.0.1:3001
--set-xauthrequest=true
--pass-user-headers=true
```

nginx in front of the API should pass the header the proxy set:

```
proxy_set_header X-Forwarded-Email $http_x_auth_request_email;
```

(Exact variable name depends on oauth2-proxy / auth_request config.)

### Cloudflare Access

Cloudflare injects `Cf-Access-Authenticated-User-Email`. Set

```
AUTH_MODE=proxy
AUTH_HEADER=cf-access-authenticated-user-email
```

and ensure Access is required for the hostname so anonymous clients never
reach Oxygen with a forged copy of that header.

### GCP IAP

IAP sends `X-Goog-Authenticated-User-Email` as
`accounts.google.com:user@example.com`. Oxygen strips the issuer prefix.
Set `AUTH_HEADER=x-goog-authenticated-user-email`. IAP must be the only
path to the load balancer.

**An expired IAP cookie in an open tab.** Same-origin `/trpc` calls are then
redirected to the Google sign-in and fail as CORS "Failed to fetch", which
looks like no network. The web client tells the two apart with a probe of
`/trpc/users.me` that does not follow redirects (`lib/session-probe.ts`): an
opaque redirect, an HTML answer or a non-JSON 401/403 is "expired", no
answer or a 502/503/504 is "unreachable". Expired over a page in use shows a
"Your sign-in has expired" banner with Reload (not on the public kiosk and
start screen); a device with nothing saved to show reloads by itself (at
most twice per five minutes). Unreachable never reloads. See
`docs/bugfixes/station-outage-resilience.md`.

## Provisioning

1. Set `OXYGEN_ADMIN_EMAILS` to at least one real mailbox.
2. Enable `AUTH_MODE=proxy` behind the IdP.
3. Optionally set `AUTH_AUTO_PROVISION=member` so anyone the proxy admits
   is created as a member (Cloud Run deploy does this).
4. Sign in; the bootstrap admin is created — or promoted, if the row already
   exists — on first request.
5. Open **Settings → Users** and invite clubmates or
   grant admin. The table shows role, club groups, last seen, and active.
6. Deactivating a user locks them out on the next request (`resolveUser`
   returns null for `active = false`). Admins cannot deactivate or de-admin
   themselves.

Journal mutations that run inside tRPC stamp `actor_id` with the user's UUID.
So does a station's `events.push` when auth is on: the signed-in user is the
actor whatever `actorId` the wire entry carries. Background jobs and ROC
pullers leave `actor_id` null; a peer node's push (node secret) keeps the
entry's own `actorId`, the origin node's attribution.

## Venue nodes

LAN venue boxes usually keep `AUTH_MODE=off` or `dev`. When a venue forwards
cloud-owned mutations, `venueForwarder` copies the configured identity header
so the cloud can attribute the call if the cloud runs `proxy` mode.

## Transition

Leave `AUTH_MODE=off` until the proxy is in place **and** at least one
bootstrap admin email is configured. Flipping to `proxy` without
`OXYGEN_ADMIN_EMAILS` (and without an existing admin row) locks everyone out
of the admin UI.

## Permissions

Per-event grants assign a **role** (a capability set, stored in
`permission_groups`) to a subject: either a single invited user or a
**club user group** (see below). Four system roles are seeded with fixed
UUIDs (`SYSTEM_GROUP_IDS` in `@oxygen/shared`):

| Role | Capabilities |
|-------|----------------|
| Event admin | `event.view`, `event.manage`, `courses.view`, `courses.edit`, `courses.review`, `race.operate`, `results.view` |
| Course setter | `event.view`, `courses.view`, `courses.edit`, `courses.review` |
| Race crew | `event.view`, `race.operate`, `results.view` |
| Member | `event.view`, `results.view` |

Race crew registers runners (`runner.create` needs `race.operate`, like a
station's queued `runner.registered`); editing a runner (`runner.update`,
`bulkUpdate`) and deleting one stay Event admin.

Instance admins receive every capability on every event. `AUTH_MODE=off`
bypasses checks (all capabilities).

**`courses.review`** (the controller's capability, slice D decision 4):
`control.check` (field check-off) and writing a control's `notes`. Every
other course and control write needs `courses.edit`, so a controller is
a custom role with `courses.view` + `courses.review` — it can check off
controls and leave notes but not move them. The migration
`20261031120000_course_structure` added it to the two seeded roles above.

**Post-race rule:** if `event.date` is before today (local `YYYY-MM-DD`) **or**
the event has at least one finished-status runner, every invited user also
gains `event.view`, `results.view`, and `courses.view`. Mutating capabilities
(`event.manage`, `courses.edit`, `courses.review`, `race.operate`) are never added this way.
Course/map data stays secret before the race unless the user is granted a
role that includes `courses.view`.

Creating an event (`competition.create` / `eventor.importEvent`) auto-grants
**Event admin** to the creator. `competition.list` only returns events where
the user has any effective capability (directly or through a club group);
the payload includes `canManage` when they have `event.manage`.

Event admins manage grants on the Event page. Custom role CRUD is not in the
UI yet; the `permission_groups` table already supports extra rows.

### Club user groups

`club_user_groups` + `club_user_group_members` define named sets of users
("Trainers", "Board", …), managed on the **Groups** tab of the settings page
(`/settings?tab=groups`). A grant row (`event_permissions`) targets exactly one of
`user_id` / `club_group_id` (enforced by a CHECK constraint). Group grants
are resolved **live**: capability checks match
`clubGroup.members.some(userId)`, so adding or removing a member takes
effect immediately on every event the group has a role on, with no grant
rows to update. Deleting a group cascades its grants away.

Because membership gates event permissions, group CRUD and membership
mutations require an instance admin (`adminProcedure`); any authed user can
read the list (the grant form and the library tab need it). Members must first
be invited through **Settings → Users**. When an admin enters an unknown email
on the Groups tab, **Invite and add** composes `users.invite` with the membership
mutation and retries the add.

### Kiosk key

`events.kiosk_key` is a random token. Event admins generate/rotate it
(`competition.regenerateKioskKey`) and put `?k=` on kiosk and start-screen
URLs. The web client sends `x-kiosk-key`. Middleware accepts a matching key
**or** a logged-in user with the relevant capability (`kioskOrCapProcedure`).
Identity-less devices without a key see an error pane (`kiosk-key-required`).

A key-only device is **display-only** apart from its own outbox: it cannot call
`cardReadout.storeReadout`, `cardReadout.applyResult`, `race.recordFinish` or
`events.push` (all need a signed-in user, or the node secret for a peer;
`recordFinish` was kiosk-key callable
until work package 2, which closed API-13), and it does not queue `result.applied`. A standalone kiosk
that loses the server keeps its `card.read` entries on the device; they are sent
when an operator signs in on the same browser profile. A venue box runs with
auth off, where none of this applies. Pinned by a test in
`permissions.test.ts`.

The key covers everything the kiosk renders after a readout, including the
course map: the read-only course/map procedures (`course.list`,
`mapMetadata`, `mapFileInfo`, `controlCoordinates`,
`controlCompletionStatus`, `getOverprintCuts`, `class.list`) sit on
`kioskOr*` procedures, and the map document fetch sends `x-kiosk-key`
itself (`lib/map-document-cache.ts`). The graphic routes
(`/api/maps/:nameId/graphics/:id`, `…/print.png`, `…/thumb.png`) accept it
too (J2): the event's own graphics and any club graphic by id
([course-maps.md](../course-maps.md) API). Mutations never accept the key.

### REST protection

| Route | Required |
|-------|----------|
| `/api/backup/*` | `event.manage`; **instance admin** if the event's current map was copied from the club library (the dump contains the OCAD blob) |
| `/api/export/course-data` | `courses.view` |
| `/api/map-sources/:hash` | `event.manage` on an event whose map is that source (`?event=` / `x-event-id`), **instance admin** if it was copied from the club library; or the uploader of a club map version with that source, or an instance admin. Never the kiosk key. See [map-storage.md](../map-storage.md) §4.4 |
| `/api/maps/:nameId/graphics/:id[/print.png\|/thumb.png]` | `courses.view`, or the event's kiosk key (J2) |
| `/health`, `/api/version`, `/api/club-logo/*` | open |

`course.downloadMap` requires `event.manage`, and instance admin when
`map_files.from_club_library` is set. `clubMap.download` matches delete:
uploader or instance admin. Tiles and previews are rendered views and stay
on the existing capability / invited-user gates — they are not the source
file. See [system/club-library.md](club-library.md#ocad-source-files).

`events.push` (the journal sink) is not an `eventProcedure`; see
[Journal push](#journal-push). Instance `users` and Eventor API-key admin are
`adminProcedure`: `eventor.validateKey`, `eventor.setKey` and
`eventor.clearKey` back the **Settings → Eventor** tab
(`/settings?tab=eventor`), which is hidden from members like the Users
and Maintenance tabs. `eventor.keyStatus` / `eventor.getKey` are
`authedProcedure` — they only say whether a key exists, and the import
panel and registration dialog need that for any invited user.

## Journal push

`events.push` is the sink for a station's outbox drain and for a peer node's
shipper. It authenticates itself (`publicEventProcedure`, not
`authedProcedure`), in this order:

1. **A node secret is presented** (`x-oxygen-sync-secret`). A wrong secret is
   `UNAUTHORIZED` (compared in constant time, like the kiosk key and
   `events.since`); a secret presented to a node with no `SYNC_SHARED_SECRET`
   is `PRECONDITION_FAILED`. Neither falls through to the user path, so a
   misconfigured box shows a clear error instead of every entry coming back
   `FORBIDDEN`. A valid secret is a peer node: no user needed (it works on an
   invite-only cloud), every entry type is accepted.
2. **No secret.** With auth on a signed-in user is required (`UNAUTHORIZED`
   otherwise; a kiosk key alone cannot push, D11). Each entry then needs the
   capability its type maps to (`journalCapabilities.ts`); with auth off every
   capability is held.

| Entry type | Capability |
|---|---|
| `card.read`, `result.applied`, `finish.recorded`, `finish.adjusted`, `start.recorded`, `punch.recorded` / `removed` / `updated`, `runner.registered` | `race.operate` |
| `start.adjusted`, `runner.updated`, `runner.deleted`, `class.upserted` | `event.manage` |
| `course.upserted`, `control.upserted`, `reference.imported` | `courses.edit` (`reference.imported` with a non-empty `classes[]` also needs `event.manage`: it writes whole class rows) |
| any other type | refused |

The table mirrors the online procedures: a queued entry is never a way around
the gate of the call it replaces. One exception: a `runner.updated` whose
`fields` is exactly `{ finishTime }` (the finish station's confirmed
overwrite, online `race.recordFinish`) needs only `race.operate`.

An entry whose id is already journaled under this event answers `synced`
before the capability check (a role revoked since does not turn an applied
entry red); the competition check still applies to it.

A refusal does not fail the request. The entry comes back in `failed[]` as
`{ id, error, capability? }` with a stable code and the batch carries on, so
one missing role does not block the rest of a queue; nothing was written, the
entry stays on the sender, and once the role is granted the same id syncs.

| `error` | Meaning |
|---|---|
| `FORBIDDEN` | the user lacks `capability` |
| `COMPETITION_MISMATCH` | the entry's `competitionId` is not the request's event (both paths) |
| `ENTRY_IN_OTHER_EVENT` | the entry id is already journaled under another event |
| `ROW_IN_OTHER_EVENT` | the entry addresses a row (runner, punch, class, course, control) of another event |
| `INVALID_PAYLOAD` | malformed payload, or a reference to a row outside the event |
| `APPLY_FAILED` | the apply threw; the message is only in the server log |

An empty `events` array answers `{ synced: [], failed: [], serverTimeMs }` for
any signed-in user (the clients' clock probe). Details of the ingest
(transaction, ordering) are in
[offline-architecture.md](offline-architecture.md#the-journal).

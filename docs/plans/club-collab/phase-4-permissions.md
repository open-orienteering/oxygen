# Phase 4 — Permission Groups & Per-Event Grants

Depends on: phase 3 (users, `authedProcedure`, `ctx.user`).

## Goal

Named permission groups (capability sets) assignable to users **per event**.
Server-side enforcement on every event-scoped procedure. The headline rule
from the product brief: before the race, course/map data is visible only to
explicitly granted users; after the race is completed, every invited user can
view all competition information.

## Model

### Capabilities (string literals, defined in `@oxygen/shared`)

| Capability | Grants |
|------------|--------|
| `event.view` | See the event in lists, dashboard, classes, runners, start list, clubs, tracks (read) |
| `event.manage` | Edit event settings, classes, runners, start draw, Eventor sync, permissions panel |
| `courses.view` | Read courses, course editor (read), controls, map, course export — the pre-race-sensitive set |
| `courses.edit` | Mutate courses, controls, map upload, course editor |
| `race.operate` | Start/finish stations, card readout, backup punches, registration desk mutations |
| `results.view` | Results page, replay/tracks results data |

Export a `type Capability` union + `ALL_CAPABILITIES` array from
`packages/shared/src/permissions.ts` (new file, re-exported from the shared
index).

### Prisma models + migration `YYYYMMDDHHMMSS_permissions`

```prisma
model PermissionGroup {
  id           String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  name         String   @unique
  capabilities Json     // string[] of Capability
  isSystem     Boolean  @default(false) @map("is_system")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  grants EventPermission[]
  @@map("permission_groups")
  @@schema("oxygen")
}

model EventPermission {
  id        String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  eventId   BigInt   @map("event_id")
  userId    String   @map("user_id") @db.Uuid
  groupId   String   @map("group_id") @db.Uuid
  grantedBy String?  @map("granted_by") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  event Event           @relation(fields: [eventId], references: [id], onDelete: Cascade)
  user  User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  group PermissionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([eventId, userId, groupId])
  @@index([eventId, userId])
  @@map("event_permissions")
  @@schema("oxygen")
}
```

The migration seeds four **system groups** (`is_system = true`, fixed UUIDs
in the migration SQL so all instances share ids):

| Group | Capabilities |
|-------|--------------|
| Event admin | all six |
| Course setter | `event.view`, `courses.view`, `courses.edit` |
| Race crew | `event.view`, `race.operate`, `results.view` |
| Member | `event.view`, `results.view` |

System groups cannot be renamed/deleted via API. Custom groups are
out of scope for the UI in this phase (the model supports them; the admin
UI edits grants only against existing groups).

## Capability resolution (pure logic, unit-tested)

`packages/api/src/permissions.ts` (new):

```
effectiveCapabilities({ user, isAdmin, grants, eventCompleted, authEnabled }): Set<Capability>
```

Rules, in order:

1. `authEnabled === false` → all capabilities (transition mode).
2. No user → empty set.
3. `user.isAdmin` → all capabilities.
4. Union of `capabilities` from the user's grant groups for this event.
5. **Post-race rule**: if `eventCompleted`, add `event.view` and
   `results.view` and `courses.view` for every active user (the "everyone
   can see everything after a completed race" requirement — course/map
   secrecy ends when the race ends).

`eventCompleted` = `event.date < today (local)` **or** the event has at least
one finished-status runner result. Implement as
`isEventCompleted(eventDate: string, finishedCount: number): boolean` in
`packages/api/src/permissions.ts`; the caller fetches `finishedCount` with a
cheap indexed count. Cache per request only (no cross-request cache).

## Enforcement

### tRPC

- New middleware factory in `trpc.ts`:
  `requireCapability(cap: Capability)` chained after `eventProcedure`.
  It loads grants (`event_permissions` join `permission_groups` for
  `ctx.user.id` + `ctx.event.id`, one query), computes
  `effectiveCapabilities`, throws `FORBIDDEN` if `cap` missing, and puts
  `ctx.capabilities` on context for handlers that branch.
- Convenience exports: `viewProcedure = requireCapability("event.view")`,
  `manageProcedure`, `coursesViewProcedure`, `coursesEditProcedure`,
  `raceOperateProcedure` (this one stacks on the existing lease check:
  `raceProcedure` + capability), `resultsViewProcedure`.
- **Sweep every event-scoped router** and rebase procedures per this map
  (read = weaker, mutate = stronger):

| Router(s) | Read | Mutate |
|-----------|------|--------|
| `competition.select/dashboard/…` | `event.view` | `event.manage` (update/delete/settings) |
| `class`, `runner`, `draw`, `club`, `registrationTrends` | `event.view` | `event.manage` |
| `course`, `control` (incl. map upload/metadata/download, geometry) | `courses.view` | `courses.edit` |
| `results` / start list reads | `results.view` / `event.view` | — |
| `cardReadout`, `race`, start/finish station, backup punches, `onlineInput` config | `race.operate` | `race.operate` |
| `lease` | `event.view` | `event.manage` |
| `events` (journal push/since) | unchanged (`peerProcedure` / event) | unchanged |
| `permission` (new) | `event.manage` | `event.manage` |
| `eventor` event-scoped (sync, push) | — | `event.manage` |
| Global: `eventor` key mgmt, `users` | admin (from phase 3) | admin |
| `competition.list` | `authedProcedure`; response filtered to events where the user has any capability (admins/auth-off see all) | `competition.create` / `importEvent` = any authed user; creator is auto-granted **Event admin** on the new event |

### Kiosk / start screen (public surfaces)

Kiosk and start-screen pages must keep working on devices with no user
identity (venue LAN). Enumerate the exact procedures those two pages call
(grep the kiosk page/components and `StartScreenPage`), and keep them on a
dedicated `kioskProcedure` = event-resolving but **not** auth-gated, and
additionally guarded by: allowed only when `AUTH_MODE=off` **or** the request
carries a valid kiosk key. Kiosk key = `events.kioskKey` (new nullable text
column on `events`, migration above): a random token generated via a new
`competition.regenerateKioskKey` (`event.manage`) mutation, shown on the
Event page; kiosk/start-screen URLs gain `?k=<key>`; the web kiosk code
passes it as `x-kiosk-key` header (add to CORS allowlist); the middleware
compares against the event row. REST map tiles used by those pages accept
`?k=` query too (`map-tiles.ts`).

### REST routes

`/api/backup/*`, `/api/export/course-data` (pre-race-sensitive!), and
`/api/map-tile/*` get a shared Fastify preHandler: resolve identity exactly
like `createContext` (reuse `auth.ts`), compute capabilities for the target
event, require `event.manage` (backup), `courses.view` (course export),
`courses.view` **or** valid kiosk key (map tiles). `/health`,
`/api/version`, `/api/club-logo/*` stay open.

## API — `permissionRouter` (new, registered as `permission`)

| Procedure | Base | Input | Behavior |
|-----------|------|-------|----------|
| `groups` | `authedProcedure` | — | List groups (id, name, capabilities, isSystem) |
| `listGrants` | manage | — | Grants for `ctx.event` with user email/name + group name |
| `grant` | manage | `{ userEmail: string.email, groupId: uuid }` | Resolve user by email (`NOT_FOUND` if not invited), upsert grant, `grantedBy = ctx.user.id` |
| `revoke` | manage | `{ grantId: uuid }` | Delete (scoped to `ctx.event`) |
| `myCapabilities` | `eventProcedure`+authed | — | `Capability[]` for current user on `ctx.event` (single query + pure fn) |

## Web changes

- `CompetitionShell`: fetch `permission.myCapabilities` alongside
  `competition.select`; store in shell state and pass down via a small
  `CapabilitiesContext` + `useCapabilities()` hook
  (`packages/web/src/hooks/useCapabilities.ts`). Tab visibility = phase 2
  relevance logic **∩** capability map (each tab entry gains
  `requiredCapability`); tabs the user lacks are fully hidden (not just
  overflowed). Route guard: navigating to a route without its capability
  renders a `ForbiddenPane` (inline message component, not a redirect).
- `EventPage`: new "Permissions" panel (visible with `event.manage`):
  grant form (email input + group select from `permission.groups`), grants
  table with revoke buttons, and the kiosk key section (show/regenerate/copy
  kiosk URL).
- Event selector: list already comes filtered from the API; no client
  filtering needed. Show a subtle "manager" badge on events where the user
  has `event.manage` (list response gains `myCapabilities` per event or a
  boolean `canManage` — prefer the boolean to keep payload small).
- i18n: extend the `auth` namespace (or add `permissions` keys to `event`
  namespace where they live on EventPage) — both locales.

## Tests (write first)

### Unit (`packages/api/src/__tests__/permissions.test.ts`)

- `effectiveCapabilities`: auth-off → all; no user → none; admin → all;
  single group union; multi-group union; post-race additions for plain
  member; post-race does NOT add `courses.edit`/`event.manage`/`race.operate`.
- `isEventCompleted`: past date no results, today with results, future date
  no results.

### Integration (`packages/api/src/__tests__/integration/permissions.test.ts`)

- Grant/revoke flow; grant to uninvited email → `NOT_FOUND`.
- Enforcement matrix (use `makeCaller` with `authEnabled: true`):
  member reads classes OK, member mutates class → `FORBIDDEN`;
  course setter reads+edits courses OK, member reads courses pre-race →
  `FORBIDDEN`, member reads courses post-race (backdate event, add finished
  runner) → OK; race crew card readout OK, course setter card readout →
  `FORBIDDEN`.
- `competition.list` filtering: user with grants on event A only sees A;
  admin sees all.
- Creator auto-grant on `competition.create`.
- Kiosk procedures: no user + correct kiosk key → OK; wrong key →
  `UNAUTHORIZED`.

### E2E (`e2e/permissions.spec.ts`)

- Three browser contexts via `extraHTTPHeaders` (admin, course-setter,
  member — provision + grant via admin UI or direct API calls in
  `beforeAll`).
- Member pre-race: courses/controls/course-editor tabs absent, direct URL
  shows forbidden pane, results/classes visible per grants.
- Course setter: course editor loads, map visible.
- Post-race (seeded completed event — the `itest` seed has results): member
  sees courses tab.
- Kiosk page with `?k=` works in an identity-less context; without key it
  shows an error state.
- Existing suite must stay green (it runs as bootstrap admin from phase 3).

## Documentation

- Extend `docs/authentication.md` with a "Permissions" section: capability
  table, system groups, post-race rule, kiosk key model, REST route
  protection matrix.
- Update `docs/features.md`.

## Acceptance criteria

1. Every event-scoped procedure is rebased onto a capability procedure (CI
   greps may be impractical — the review gate checks the sweep manually;
   the executor lists every router touched in the final summary).
2. Pre-race course/map secrecy holds across tRPC, REST export, and map
   tiles; post-race visibility opens automatically with no manual step.
3. Kiosk and start screen work with no identity given a valid kiosk key.
4. `AUTH_MODE=off` still bypasses everything (full legacy behavior).
5. Full §6 checklist passes.

## Out of scope

- Custom group creation/editing UI (model supports it; UI later).
- Fine-grained per-class or per-course permissions.
- Audit UI for `grantedBy` (data is stored).

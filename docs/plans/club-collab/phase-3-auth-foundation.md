# Phase 3 — Auth Foundation (proxy-header identity, users, admin UI)

## Goal

Introduce user identity without any password handling: a trusted reverse
proxy (oauth2-proxy / Cloudflare Access / GCP IAP) injects the authenticated
email as a request header; Oxygen resolves it against an invite-only `users`
table. This phase delivers identity plumbing, user management, journal actor
attribution, and web-side gating. Server-side per-capability enforcement is
phase 4.

## Current state (verified)

- `Context` in `packages/api/src/trpc.ts` holds only `event` and
  `syncSecret`; `createContext` parses `x-event-id`/`x-competition-id`.
  Procedure ladder: `publicProcedure` → `eventProcedure` → `raceProcedure`
  / `peerProcedure`.
- `appendJournal` in `packages/api/src/journalEmit.ts` takes `actorId`
  ("Always null until the permissions system ships"); no call site passes it.
- No `User` model. Global settings use the `Setting` KV model — do **not**
  use that for users.
- Web bootstrap `packages/web/src/main.tsx`: `trpc.Provider` →
  `PersistQueryClientProvider` → `BrowserRouter` → `App`. No user context.
- Env is read via `dotenv/config` + direct `process.env`.
- Integration tests build context directly via
  `packages/api/src/__tests__/helpers/caller.ts` (`makeCaller(event, extra)`).
- E2E stacks are launched from `playwright.config.ts` `webServer[]` with env
  injection; Vite proxies `/trpc` and `/api` to the API, forwarding headers,
  so Playwright `extraHTTPHeaders` reach the API.

## Configuration

New env vars (read in a new module `packages/api/src/auth.ts`):

| Var | Default | Meaning |
|-----|---------|---------|
| `AUTH_MODE` | `off` | `off`: `ctx.user = null`, no gating anywhere (today's behavior). `proxy`: identity from trusted header. `dev`: fixed identity `AUTH_DEV_EMAIL`. |
| `AUTH_HEADER` | `x-forwarded-email` | Header name carrying the authenticated email (proxy mode). |
| `AUTH_DEV_EMAIL` | `dev@localhost` | Identity used in `dev` mode. |
| `OXYGEN_ADMIN_EMAILS` | empty | Comma-separated bootstrap admins, auto-provisioned (active, `is_admin`) on first request with that identity. |

Header value parsing: trim, lowercase; if the value contains `:` take the
substring after the **last** `:` (GCP IAP sends
`accounts.google.com:user@example.com`). Reject values that don't match a
minimal email shape (`/^[^@\s]+@[^@\s]+$/`) — treat as unauthenticated.

Update `.env.example` with all four vars and a comment block explaining the
proxy trust model (the header is only trustworthy behind a proxy that strips
client-supplied copies — document this prominently in the docs page too).

## Data model

New Prisma model + migration `YYYYMMDDHHMMSS_users` (schema `oxygen`):

```prisma
model User {
  id          String    @id @default(dbgenerated("uuidv7()")) @db.Uuid
  email       String    @unique
  displayName String    @default("") @map("display_name")
  isAdmin     Boolean   @default(false) @map("is_admin")
  active      Boolean   @default(true)
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  lastSeenAt  DateTime? @map("last_seen_at") @db.Timestamptz(6)

  @@map("users")
  @@schema("oxygen")
}
```

Migration must attach the existing `oxygen.set_updated_at()` trigger to
`users` (follow the pattern from the initial migration). Emails are stored
lowercase; normalize in code before every lookup/insert.

`JournalEntry.actorId` already exists — no schema change needed there.

## API changes

### `packages/api/src/auth.ts` (new)

- `authMode()`, `authHeaderName()` — env accessors (lazy, like
  `nodeIdentity.ts`).
- `parseIdentityEmail(headerValue: string | string[] | undefined): string | null`
  — pure, unit-testable (IAP prefix strip, lowercase, shape validation).
- `resolveUser(email: string): Promise<User | null>` — `findUnique` by email;
  if not found and email is in `OXYGEN_ADMIN_EMAILS`, create it
  (active admin, displayName from email local part). If found, update
  `lastSeenAt` at most once per 5 minutes (compare in code, fire-and-forget).
  Inactive users resolve to `null` (deactivation = lockout).

### `trpc.ts`

- `Context` gains `user: User | null` and `authEnabled: boolean`
  (`authMode() !== "off"`).
- `createContext`: in `proxy` mode run `parseIdentityEmail` on
  `req.headers[authHeaderName()]` then `resolveUser`; in `dev` mode
  `resolveUser(AUTH_DEV_EMAIL)` with auto-provision-as-admin semantics
  (treat the dev email as an implicit bootstrap admin); in `off` mode
  `user = null`.
- New `authedProcedure = publicProcedure.use(...)`: when `authEnabled` and
  `ctx.user === null` → `TRPCError UNAUTHORIZED`; when `authEnabled` is
  false, pass through. Exposes `ctx.user` non-null in the typed context when
  enabled (type it as `User | null` and let phase 4 tighten; keep it simple:
  `interface AuthedContext extends Context { user: User }` guarded at
  runtime only when `authEnabled` — see "off-mode caveat" below).
- **Off-mode caveat**: procedures downstream must not assume `ctx.user` is
  non-null, because `AUTH_MODE=off` passes through. Use
  `ctx.user?.id ?? null` for attribution.
- `eventProcedure` chains from `authedProcedure` instead of
  `publicProcedure` (so once auth is on, every event-scoped call requires a
  known user). `peerProcedure` must **not** require a user — rebase it so it
  chains the event resolution but bypasses the auth gate (machine identity
  via shared secret is sufficient). Simplest structure: extract the event
  check into a shared middleware function used by both an
  `authedEventProcedure` (exported as `eventProcedure`) and a
  `peerProcedure` built directly on `publicProcedure`.
- Public allowlist for this phase (stay on `publicProcedure`):
  `users.me`, `competition.list` is NOT public (it's behind login),
  health/version REST stays open. Kiosk/start-screen-used procedures are
  enumerated and gated in phase 4 — in this phase, **when `AUTH_MODE=off`
  nothing changes**, and deployments should keep `off` until phase 4 lands.
  (The E2E suite flips to `proxy` mode in this phase already — see Tests.)

### `usersRouter` (new, `packages/api/src/routers/users.ts`, registered as `users`)

| Procedure | Base | Input (zod) | Behavior |
|-----------|------|-------------|----------|
| `me` | `publicProcedure` | — | `{ authMode, user: { id, email, displayName, isAdmin } \| null }` |
| `list` | `adminProcedure` | — | All users, ordered by email |
| `invite` | `adminProcedure` | `{ email: string.email, displayName?: string, isAdmin?: boolean }` | Lowercase email, create; `CONFLICT` if exists |
| `update` | `adminProcedure` | `{ id: string.uuid, displayName?, isAdmin?, active? }` | Admins cannot deactivate or de-admin themselves (`BAD_REQUEST`) |

`adminProcedure = authedProcedure` + require `ctx.user?.isAdmin` when
`authEnabled` (`FORBIDDEN` otherwise; pass-through when auth off).

### Journal attribution

- `appendJournal` call sites that run inside tRPC procedures: pass
  `actorId: ctx.user?.id ?? null`. Sweep all call sites (grep
  `appendJournal(`); update the doc comment ("Always null…" is no longer
  true). Entries from background jobs / pullers / peer ingest stay `null`.
- `sync/venueForwarder.ts`: add `authHeaderName()` to the forwarded header
  list so venue-node identity propagates upstream.
- CORS `allowedHeaders` in `index.ts`: add the auth header name (needed for
  direct-API LAN clients; harmless otherwise).

## Web changes

- New `packages/web/src/context/CurrentUserContext.tsx`:
  `CurrentUserProvider` wrapping `App` content (inside `trpc.Provider`,
  around `BrowserRouter` in `main.tsx`). Queries `users.me` once
  (staleTime ~60s). Exposes `{ user, authEnabled, isLoading }` via
  `useCurrentUser()`.
- Gating in `App.tsx`: if `authEnabled && !isLoading && user === null`,
  render a full-page `AccessDeniedPage` (new,
  `packages/web/src/pages/AccessDeniedPage.tsx`) for **all** routes except
  `/:nameId/kiosk` and `/:nameId/start-screen` (these remain renderable;
  their API enforcement is settled in phase 4). AccessDenied shows the
  identity state: "signed in as x but not invited" vs "no identity
  received", plus a hint to contact the club admin.
- User chip: small element showing `displayName || email` in
  `CompetitionSelector` header area and in the `CompetitionShell` sticky
  header (next to the existing indicators). Hidden when auth is off.
- Admin Users page: new route `/admin/users` (top-level, outside the shell,
  lazy-loaded like the selector), linked from the selector footer only for
  `user.isAdmin`. Table of users (email, name, admin toggle, active toggle),
  invite form (email + optional name + admin checkbox). Use standard
  TanStack mutation + invalidate patterns.
- i18n: new namespace `auth` — create
  `packages/web/src/i18n/locales/{en,sv}/auth.json`, register in the i18n
  resource map and in `i18next.d.ts`. All strings for AccessDenied, user
  chip, admin page, invite form in both languages.

## Tests (write first)

### Unit (`packages/api/src/__tests__/auth.test.ts`)

- `parseIdentityEmail`: plain email, uppercase → lowercase, IAP
  `accounts.google.com:x@y.se` prefix strip, array header, garbage → null,
  empty → null.
- Bootstrap admin list parsing (whitespace, case).

### Integration (`packages/api/src/__tests__/integration/users.test.ts`)

- Invite → list → update flow via `makeCaller(null, { user: adminUser, authEnabled: true })`.
- Duplicate invite → `CONFLICT`; case-insensitive duplicate.
- Non-admin caller on `list`/`invite` → `FORBIDDEN`.
- Self-deactivation blocked.
- Deactivated user: `resolveUser` returns null.
- Journal attribution: run one journaled mutation (e.g. runner create) with
  a user in context; assert `JournalEntry.actorId === user.id`. Update the
  two existing assertions that expect `actorId === null` for
  actor-less contexts (`journal-emit.test.ts`, `events-push.test.ts`) —
  they should still pass since those callers have no user.

### E2E (`e2e/auth.spec.ts` + config changes)

- `playwright.config.ts`: API `webServer` env gains `AUTH_MODE=proxy`,
  `OXYGEN_ADMIN_EMAILS=e2e-admin@oxygen.test`; default
  `use.extraHTTPHeaders = { "x-forwarded-email": "e2e-admin@oxygen.test" }`
  so all existing specs run as a bootstrap admin unchanged. Verify the full
  existing suite passes with this before writing new tests.
- New spec: fresh `browser.newContext({ extraHTTPHeaders: {} })` (no
  identity) → `/` shows access-denied testid; context with an uninvited
  email → access-denied "not invited" variant; admin invites that email via
  UI → reload → selector visible; kiosk route still renders without
  identity.

## Documentation

- New `docs/authentication.md`: trust model (proxy strips inbound copies of
  the header — show oauth2-proxy and Cloudflare Access config snippets),
  env vars, provisioning flow, dev mode, AUTH_MODE=off transition guidance,
  venue-node note (LAN venue nodes typically run `off` or `dev`; identity
  forwards via the venue forwarder when set).
- Update `docs/features.md` and `.env.example`.

## Acceptance criteria

1. `AUTH_MODE=off` (default): zero behavior change; full existing test
   suites pass without modification other than the two actorId assertions.
2. `AUTH_MODE=proxy` + valid invited header → app works, user chip visible,
   journal entries attributed.
3. Unknown/uninvited identity → UI access denied; tRPC event procedures
   return `UNAUTHORIZED`.
4. Admin can invite/deactivate; deactivated users are locked out within the
   `lastSeenAt` refresh window (immediately on next context creation).
5. Peer sync (`events.push`/`since` with shared secret) works with no user.
6. Full §6 verification checklist passes with the E2E suite running in
   `proxy` mode.

## Out of scope (later phases)

- Per-event permissions, capabilities, group management (phase 4).
- Kiosk/start-screen API enforcement and any device-token scheme (phase 4).
- REST download route protection (`/api/backup/*`, `/api/export/*`) —
  phase 4.

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
| `OXYGEN_ADMIN_EMAILS` | empty | Comma-separated bootstrap admins. On first request with that identity, Oxygen creates an active admin row (display name = email local part). |

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

Every request except `users.me`, health/version, and (until phase 4) some
kiosk REST surfaces is gated at the tRPC layer once `eventProcedure` /
`authedProcedure` run. Unknown or uninvited emails get `UNAUTHORIZED` from
event-scoped procedures. The UI shows **Access denied** for every route except
`/:nameId/kiosk` and `/:nameId/start-screen` (those pages still render; their
API calls are locked down in the permissions phase).

Bootstrap: put the first operator in `OXYGEN_ADMIN_EMAILS`. They can invite
everyone else from `/admin/users`.

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

## Provisioning

1. Set `OXYGEN_ADMIN_EMAILS` to at least one real mailbox.
2. Enable `AUTH_MODE=proxy` behind the IdP.
3. Sign in; the bootstrap admin is created on first request.
4. Open **Users** on the event selector footer and invite clubmates.
5. Deactivating a user locks them out on the next request (`resolveUser`
   returns null for `active = false`). Admins cannot deactivate or de-admin
   themselves.

Journal mutations that run inside tRPC stamp `actor_id` with the user's UUID.
Background jobs, ROC pullers, and peer `events.push` leave `actor_id` null.

## Venue nodes

LAN venue boxes usually keep `AUTH_MODE=off` or `dev`. When a venue forwards
cloud-owned mutations, `venueForwarder` copies the configured identity header
so the cloud can attribute the call if the cloud runs `proxy` mode.

## Transition

Leave `AUTH_MODE=off` until the proxy is in place **and** at least one
bootstrap admin email is configured. Flipping to `proxy` without
`OXYGEN_ADMIN_EMAILS` (and without an existing admin row) locks everyone out
of the admin UI.

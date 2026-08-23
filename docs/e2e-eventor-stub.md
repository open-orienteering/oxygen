# The Eventor stub in E2E

The E2E suite used to make real HTTP calls to `eventor.orientering.se`.
Since August 2026 it doesn't: each stack runs a small stub
(`e2e/eventor-stub.mjs`) and the API is pointed at it.

## Why

Three tests in `e2e/event.spec.ts` need an Eventor API key to be
*configured* before the Runner Database and Club Sync panels render —
both are gated on `syncStatus.data?.apiKeyConfigured`. The only way to
configure one is the `eventor.validateKey` mutation, and
`eventorKeyStore.setKey` persists the key **only if Eventor validates
it**:

```ts
async function setKey(apiKey, env) {
  const org = await deps.validateApiKey(apiKey, env);  // network call
  cache.set(env, { apiKey, org });
  await deps.setSetting(SETTING_KEYS[env], apiKey);
  return org;
}
```

So the tests rested on two assumptions, both false:

1. **That Eventor is reachable.** It is a third-party service. When it
   is down — as it was on 2026-08-23, refusing connections for at least
   ten minutes — `validateApiKey` throws, no key is stored, the panels
   never render, and the tests fail with a stack trace that points at a
   missing DOM node rather than at the real cause.

2. **That Eventor accepts the key.** The key in those tests,
   `df34af90a0c64ca4abfe9492be057e9c`, is the i18n placeholder
   `df34af90...` (`event.json` → `apiKeyPlaceholder`) padded out to 32
   hex characters. It is not a credential, and a live Eventor should
   answer it with a 403.

The tests passed historically because E2E ran against the shared **dev**
database, where the developer's own real key was already present — the
`validateKey` call failed silently (its response is never asserted) and
the panels rendered off the pre-existing row. That is also what
[`bugfix-eventor-key-wiped-by-e2e.md`](bugfix-eventor-key-wiped-by-e2e.md)
was about: the suite kept clobbering that real key. Once E2E moved to
dedicated `oxygen_e2e*` databases and `global-setup.ts` started deleting
both key rows on every run, the crutch was gone and the tests could only
ever pass when the live service happened to accept a fabricated key.

## How

`packages/api/src/eventor.ts` resolves its base URL per call:

```ts
function eventorBaseUrl(env: EventorEnvironment): string {
  const override = process.env.EVENTOR_API_BASE_URL;
  if (!override) return EVENTOR_URLS[env];
  return override.endsWith("/") ? override : `${override}/`;
}
```

`EVENTOR_API_BASE_URL` overrides both `prod` and `test`. It is set only
by `playwright.config.ts`, which passes
`http://127.0.0.1:${EVENTOR_PORT}/` to the API webServer and starts the
stub on the same port. Unset it everywhere else; production reads the
hardcoded Eventor hosts.

The trailing-slash normalisation matters: `new URL(relative, base)`
resolves against the base's *directory*, so an override of
`http://host/api` without the slash would silently drop `/api`.

## What the stub serves

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/organisation/apiKey` | `Organisation` 1234 / "E2E Test Club" |
| `GET` | `/events` | `EventList` with three events dated **today** |
| any | anything else | `404` naming the method and path |
| any | request with no `ApiKey` header | `403` (maps to `EventorAuthError`) |

Two deliberate choices:

- **Events are dated today**, not a fixed date. The import panel asks
  for a six-month window around now, so hardcoded dates would age out of
  range and the list would quietly go empty.
- **Unhandled endpoints 404 loudly** rather than returning a plausible
  empty document. A test that starts exercising new Eventor surface
  should fail and name the handler to add, not assert against fabricated
  emptiness.

## Adding an endpoint

Add a branch in `e2e/eventor-stub.mjs` returning XML in the shape the
matching parser in `packages/api/src/eventor.ts` expects (check its
`parser.parse` usage and the `isArray` list at the top of that file for
which elements must be arrays). No Playwright config change is needed.

## Coverage this recovered

`e2e/eventor.spec.ts` → "should validate Eventor API key and show event
list" was `test.skip`ped with the comment *"requires a valid Eventor API
key and live network access"*. It now runs, and asserts against the
stub's organisation and event names so it fails if the list stops
reaching the UI.

## What is still not covered

The stub only implements what the suite calls. Sync, entries, results,
club logos and the IOF XML uploads are covered by unit and integration
tests that mock at the module level (`vi.mock("../../eventor.js")` — see
`packages/api/src/__tests__/integration/eventor-*.test.ts`), not through
this stub. Real Eventor compatibility — that the live service still
returns the shapes the parsers expect — is not verified by any automated
test, by design; that is a manual check against the real API.

# Eventor API key wiped on every E2E run

## Symptom

The Eventor API key (`MeOSMain.oxygen_settings.eventor_api_key`) kept
disappearing — every "few hours of normal development", the user would
open the app and find the production Eventor API key gone, while the
test slot (`eventor_api_key_test`) was set to the literal placeholder
string `df34af90a0c64ca4abfe9492be057e9c` from the i18n translations.

Re-entering the key worked, but the key would vanish again the next
time. Earlier fixes (`c545557`, `f6cd761`) closed the auto-deletion
paths inside the API itself, so by April 2026 the running server code
was no longer the culprit.

## Root cause

`MeOSMain` is shared between the dev servers, the Docker stack, and
**every E2E run**. The `oxygen_settings` table holds the Eventor keys
globally, and the E2E suite was hitting the public tRPC mutations
directly against that real database:

- `e2e/eventor.spec.ts` — `clearEventorKey()` posted to
  `/trpc/eventor.clearKey` with `data: {}`. The router defaults
  `env` to `"prod"`, so this issued a
  `DELETE FROM oxygen_settings WHERE SettingKey = 'eventor_api_key'`
  every time the test ran.
- `e2e/event.spec.ts` — three tests posted to `/trpc/eventor.validateKey`
  with the placeholder string `df34af90a0c64ca4abfe9492be057e9c`,
  validating it against Eventor and persisting whatever the server
  accepted.

Because `pnpm test:e2e` is mandatory in the §6 verification checklist
in `AGENTS.md`, every "task complete" cycle nuked the developer's real
Eventor API key. The DB state at investigation time told the story:

```text
eventor_api_key_test  →  df34af90a0c64ca4abfe9492be057e9c   (placeholder)
eventor_api_key       →  (missing)                          (deleted by clearKey)
```

## Fix

Snapshot/restore the two Eventor key rows around the E2E run, in the
existing Playwright globalSetup plus a new globalTeardown:

- `e2e/global-setup.ts` writes the current values of `eventor_api_key`
  and `eventor_api_key_test` into `e2e_backup_*` rows in the same table
  before any test runs. If a backup row already exists from a
  previously interrupted run, it is left intact — overwriting it would
  cement the test-injected value as the "real" one on the next
  teardown.
- `e2e/global-teardown.ts` reads the backup rows and either restores
  the original value or deletes the live row (using the `__E2E_NULL__`
  sentinel for "the key was originally absent"), then removes the
  backup.

Tests can keep doing what they need to (clearing the key to verify the
"API key step" UI, validating fake keys to surface the sync panels) —
the developer's real key just survives the round-trip.

The fix is contained to `e2e/global-setup.ts`, the new
`e2e/global-teardown.ts`, and a `globalTeardown` line in
`playwright.config.ts`. No production code changes.

## Recovery

Re-enter your Eventor API key from the competition selector once. Any
existing competitions linked to `prod` will start working immediately
(they only depend on the key being present in `MeOSMain.oxygen_settings`).

## How to verify

1. Set `eventor_api_key` to a known value in `oxygen_settings`.
2. Run `pnpm test:e2e`.
3. Confirm the row still has the same value in `oxygen_settings`
   afterwards.

While the suite is running, the value will temporarily be missing
(that is the intended test behavior); it gets restored by
`global-teardown` once Playwright finishes.

# Eventor API key wiped on every E2E run

## Symptom

The Eventor API key (`oxygen.oxygen_settings.eventor_api_key`) kept
disappearing — every "few hours of normal development", the user would
open the app and find the production Eventor API key gone, while the
test slot (`eventor_api_key_test`) was set to the literal placeholder
string `df34af90a0c64ca4abfe9492be057e9c` from the i18n translations.

Re-entering the key worked, but the key would vanish again the next
time. Earlier fixes (`c545557`, `f6cd761`) closed the auto-deletion
paths inside the API itself, so by April 2026 the running server code
was no longer the culprit.

## Root cause

The `oxygen` database is shared between the dev servers, the Docker
stack, and **every E2E run**. The `oxygen.oxygen_settings` table holds
the Eventor keys globally, and the E2E suite was hitting the public
tRPC mutations directly against that real database:

- `e2e/eventor.spec.ts` — `clearEventorKey()` posted to
  `/trpc/eventor.clearKey` with `data: {}`. The router defaults
  `env` to `"prod"`, so this issued a
  `DELETE FROM oxygen.oxygen_settings WHERE setting_key = 'eventor_api_key'`
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
existing Playwright globalSetup plus a new globalTeardown.

### Original DB-row snapshot (insufficient)

The first iteration stored the snapshot back into `oxygen_settings`
itself, as `e2e_backup_*` rows, with idempotency to "leave existing
backups intact" across interrupted runs.

That broke whenever a run was interrupted before teardown:

1. Run A snapshots the real key into `e2e_backup_eventor_api_key`.
2. Tests run, live key is wiped to placeholder/empty.
3. Ctrl-C / crash before teardown. State: live polluted, backup = real.
4. User notices, manually re-enters real key in the UI.
5. Run B starts; setup sees backup exists → idempotent skip; backup
   is *not* refreshed.
6. Tests run, live wiped again.
7. Teardown reads (now stale) backup → overwrites the user's freshly
   re-entered key with the previous snapshot, or — worse — with whatever
   placeholder value the snapshot was written with if the original
   snapshot itself was taken during a polluted state.

### Current file-based snapshot

The snapshot now lives in a gitignored file at
`e2e/.eventor-snapshot.json`. The setup/teardown logic is:

- `e2e/global-setup.ts`:
  - Reads the current live values of `eventor_api_key` and
    `eventor_api_key_test`.
  - For each, classifies the live value as "test pollution"
    (null / empty / equal to the e2e placeholder string) or "real".
  - If real and different from the snapshot file → updates the snapshot
    (this is how a manually re-entered key after an interrupt is
    picked up).
  - If polluted → keeps the existing snapshot intact and never lets
    test pollution become the new ground truth.
- `e2e/global-teardown.ts`:
  - Reads the snapshot file.
  - For each captured key, restores the live row from the snapshot
    (or deletes it when the snapshot recorded an originally absent
    row, represented as `null` in JSON).
  - The snapshot file itself stays on disk across runs — no
    self-erasing on success — so the next interrupted run is still
    recoverable.

Legacy DB-row backup entries (`e2e_backup_*`) are deleted on every
setup so they can't be silently consulted by anything anymore.

Tests can keep doing what they need to (clearing the key to verify the
"API key step" UI, validating fake keys to surface the sync panels) —
the developer's real key just survives the round-trip.

The fix is contained to `e2e/global-setup.ts`, `e2e/global-teardown.ts`,
the `globalTeardown` line in `playwright.config.ts`, and a `.gitignore`
entry for the snapshot file. No production code changes.

## Recovery

Re-enter your Eventor API key from the competition selector once. Any
existing competitions linked to `prod` will start working immediately
(they only depend on the key being present in `oxygen.oxygen_settings`).

## How to verify

1. Set `eventor_api_key` to a known value in `oxygen_settings`.
2. Run `pnpm test:e2e`.
3. Confirm the row still has the same value in `oxygen_settings`
   afterwards.

While the suite is running, the value will temporarily be missing
(that is the intended test behavior); it gets restored by
`global-teardown` once Playwright finishes.

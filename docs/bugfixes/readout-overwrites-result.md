# Bugfix: a re-read or a manual finish overwrote the stored result

Full review work package 2 (RES-01 with SI-01, SI-10 with RES-12, SI-11, WEB-53, WEB-72, SI-17). Also closes API-13 for `race.recordFinish` and the `result.applied` part of SI-08/SYNC-06 (status mapping on ingest).

## Symptom

- A jury DQ, an organiser's MP→OK correction or a hand-set status was replaced when the runner read the card again.
- A cleared hire card put into a reader turned an OK result into DNF with finish 0.
- A finish keyed in on the Finish Station was erased by a later read of a card without a finish punch, and one Enter on an already finished runner replaced the finish with "now".
- Pushing a readout-station backup stored the card but wrote no result.
- A slow earlier card could overwrite the card on the operator's screen and the kiosk after a later card.
- The kiosk wrote its own finish on first reads, racing the admin tab.

## Root cause

Storing a card, evaluating it and writing the result happened in different places, and nothing compared the new result with the stored one: `applyResult` wrote whatever the client computed, `storeReadoutImpl` overwrote `cards.punches_raw` unconditionally, `performReadout` ignored a stored manual finish, `pushReadoutBackup` had no apply step, and the offline `result.applied` ingest wrote unconditionally.

## Fix

- One guard, `decideReadoutApply` (shared), used by `applyResultGuarded` for `applyResult`, `pushReadoutBackup` and the `result.applied` ingest. DQ and hand-set statuses are protected, a hand-keyed finish is kept, a worse read (no finish, not fresh) returns `needsConfirmation`, identical values are `unchanged` and not journaled.
- `runners.status_manual` / `finish_manual` (migration `20261124120000_readout_apply_guards`), set by `runner.update` (only when the value changes), bulk DNS, the Finish Station and `finish.*` ingest.
- `storeReadoutImpl` keeps the earlier `punches_raw` when an empty or not-fresh read arrives for a runner with a result (`cardHeld`).
- `performReadout` uses a hand-keyed finish when the card has no finish punch.
- `race.recordFinish` needs a signed-in operator (no kiosk key) and refuses a different existing finish with `FINISH_EXISTS` unless `allowOverwrite`. The Finish Station asks ("Replace finish HH:MM:SS with now"), ignores plain Enter on a finished runner, guards double Enter, takes the time once at the key press and queues on any network-class error.
- DeviceManager shows a banner for a held read (replace / keep) and keeps the latest card on screen (`latestCardIdRef`); the kiosk lost its `recordFinish` effect and refetches on a `readout-applied` message.

## Left as it was, on purpose

- A manual finish stays even when the card has a finish punch (conservative: never overwrite a manual time). The operator corrects it on the runner.
- Offline, a read the guard holds on ingest is not prompted to anyone (the stored result stays); re-reading online asks. A "held readouts" list is a follow-up.
- `card.read` ingest does not apply a result by itself (only `result.applied` does); applying on ingest as a leaseholder follow-up is left out.
- Status after a manual finish with no card: online leaves it `unknown`, the offline `finish.recorded` sets `ok` (as before); not unified.
- WEB-52, SI-09, a "push all pending" button for backups, per-type capabilities on `events.push` (API-12) and `card_readouts` header-time columns are left out.

- The kiosk and the printed receipt of a held read show the stored result; the offline client (projection) does not run the guard yet, so an offline re-read of a DQ shows OK locally until sync (the server then keeps the DQ).
- Eventor sync, `runner.create` and `runner.updated` replay on a peer holding the same value do not set the manual flags (RES-02 and package 5 territory).
- `applyResultGuarded` reads then writes without a row lock; a DQ committed in that instant can be overwritten.

## Tests

`readout-guard.test.ts`, `readout-policy.test.ts` (unit); `readout-apply.test.ts` (integration: DQ, hand-set status, cleared card, not-fresh read, manual finish, `FINISH_EXISTS`, backup push, `result.applied` ingest); `e2e/finish-station.spec.ts`.

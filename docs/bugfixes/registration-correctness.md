# Registration desk stored wrong clubs, names and cards; offline registrations lost fields

Package 10 of the November 2026 full code review (work queue row 10):
SYNC-12 (DB-11), WEB-05, WEB-06, WEB-10, WEB-11, WEB-19, WEB-20 (CRS-012),
WEB-22, API-11 (DB-22, SI-19).

## What happened

- **Offline registrations lost fields (SYNC-12).** The offline dialog queued only
  name, class, card, start time and a `clubId` the server never read: club,
  birth year, sex, phone and payment were lost. The server's own
  `runner.registered` (from `runner.create`) also left out the person and
  payment fields, so a follower node lost them for online registrations too.
  A station registration whose class was gone, or whose card another runner
  held, was acked as synced and skipped; the entrant's queued finish then
  resolved by card to the other runner.
- **"No club" saved as a free-text club (WEB-06).** The picker keyed clubs by
  the roster's numeric id; free-text clubs have id 0, the value "No club"
  used, so "No club" submitted the first free-text club's name.
- **Only roster clubs (WEB-11).** A club nobody in the event belonged to could
  not be picked, and a suggestion or card lookup carrying such a club dropped
  it.
- **Stale owner data (WEB-05).** The SI owner data of one card stayed in a ref
  and named the next card that had none (sticky mode, manual entry).
- **Carry-over (WEB-19).** Opening the dialog from a card read kept the
  previous runner's rental tick, receipt tick and payment method.
- **Double submit and a waiting print (WEB-20, CRS-012).** Register was only
  disabled during the online mutation, and the dialog awaited the logo fetch
  and the print before clearing: a second press created the runner twice (or
  queued it twice offline), and a stuck printer held the desk.
- **Generic errors (WEB-22).** Every server error read "Registration failed";
  a known card could be submitted; a manual card entry hung when its check
  failed.
- **Bulk "Set club" (WEB-10)** sent only the Eventor id (0 for free-text clubs)
  and left the name as it was.
- **Stale card link (API-11).** Changing a runner's card number left
  `runner.cardId` pointing at the old card row, which the readout and the
  Eventor result upload preferred: the new card's punches were ignored.

## Fix

- `RunnerRegisteredPayload` (shared) carries the whole form; the dialog's
  offline path and `runner.create` send it, the apply stores it. A push from a
  station's outbox refuses an unknown class (`CLASS_NOT_FOUND`) or a card held
  by a runner with another name (`CARD_TAKEN`); both stop the batch so the
  entries behind wait. A peer push keeps the skip.
- Club choices are keyed by `e:<eventorId>` / `n:<name>` / `""`
  (`web/src/lib/club-options.ts`), with ad-hoc options for clubs from
  suggestions and lookups and a directory search when the roster has no match.
- Owner data is held with its card number; every form reset (card read,
  manual entry, sticky clear) starts from `clearForm()`, with one
  `defaultPaymentMode` rule.
- One submit at a time (`submittingRef`); the print runs after clear/close,
  not awaited; logo load (10 s) and USB transfer (30 s) are time-bounded.
- `registrationErrorMessage` maps CONFLICT / FORBIDDEN / NOT_FOUND / network
  failures to their own texts; Register is disabled for a known card.
- `bulkUpdate` sends and stores name plus id; 0 means none; a missing name
  comes from the club directory.
- `cardId` follows `cardNo` on every write (`liveCardId`), `pickRunnerCard`
  ignores a stale link on read, unlink clears it, linking a taken card is
  CONFLICT, and a lost race on the unique index answers CONFLICT.

No migration.

## Tests

- Unit: `web/src/lib/__tests__/club-options.test.ts`,
  `web/src/lib/__tests__/registration-form.test.ts`,
  `api/src/__tests__/cardLink.test.ts`.
- Integration: `events-push.test.ts` ("station registrations (SYNC-12)",
  "card link follows the card number (API-11)"), `runner.test.ts`
  ("runner.bulkUpdate club").
- E2E: `registration-dialog.spec.ts` "Registration correctness",
  `rental-cards.spec.ts` (WEB-19), `offline.spec.ts` (SYNC-12),
  `runners-bulk.spec.ts` (WEB-10).

Technical description: `docs/system/registration-and-readout.md` §5a, §3e and §8.
Left out: [registration-followups.md](registration-followups.md).

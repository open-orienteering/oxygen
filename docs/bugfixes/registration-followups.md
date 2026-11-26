# Registration: follow-ups left out of package 10

Edge cases found while fixing [registration-correctness.md](registration-correctness.md)
and left for later, with the reason.

- **One card row per (event, card number) for successive hire-card holders
  (SI-19, second scenario).** A hire card handed to a second runner still
  shares the first holder's card row. After package 10 the first holder is
  unlinked rather than shown the next holder's punches, but the punches
  themselves are not split per holder. Needs a schema and readout-model change.
- **Discarding a `CARD_TAKEN` registration.** The entries queued after it for
  that card (a finish, a readout) then apply to the card's other holder. The
  refusal text tells the operator to fix the card number first; a "re-point
  queued entries" action is not built.
- **No "move card" action.** Register stays disabled for a known card; moving a
  card from one runner to another is done on the Runners page (unlink, then
  link).
- **`club.list` `showAll` (DB-25).** Still accepted and ignored; the Clubs page
  toggle does nothing. Clubs are not first-class rows, so "all clubs" would
  mean the directory. `club.list` / `club.detail` still key free-text clubs by
  id 0 for the Clubs page.
- **WEB-23 (prefill order) and WEB-21 (Esc inside a dropdown).** Owner data
  can still fill the name before an Eventor lookup answers, contrary to §8b;
  Esc in the club or class dropdown also closes the dialog. Separate findings.
- **Other receipts.** Only the shared USB transfer and the logo load got a
  timeout; `PrinterContext.print` for other receipt types has none of its own.
- **Silent skips of `finish.recorded` / `result.applied` for no runner.** Not
  refused in general (SYNC-20): a deleted runner is a benign case and a refusal
  would block the outbox. The failed-registration case is covered by the hold.
- **The runner editor's club picker (`RunnerInlineDetail`)** still lists only
  roster clubs.

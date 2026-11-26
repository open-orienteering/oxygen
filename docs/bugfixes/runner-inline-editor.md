# Runner editor dropped edits behind "Saved" and refused saves silently

Package 11 of the November 2026 full code review (work queue row 11):
WEB-07 and WEB-08. Component: `packages/web/src/components/RunnerInlineDetail.tsx`
(the inline pane on the Runners, Start list and Results pages).

## What happened

- **Dropped edit (WEB-07).** The pane had one 600 ms debounce timer. Each edit
  cleared it and the surviving call sent only its own field, so a name
  corrected and a card number typed within 600 ms saved only the card. The
  pane still showed "Saved", and the name input kept the unsaved text.
- **Refetch rewrote typing (WEB-07).** Every save refetched the runner, and the
  inputs copied any new stored value unconditionally. When typing resumed
  during that round trip, the answer for the earlier prefix replaced the newer
  text: a card number "12" + "345" briefly became "12" again.
- **Silent refusals (WEB-08).** A card held by another runner (CONFLICT), an
  empty name and class "-" were refused by the server with nothing shown but
  a missing "Saved"; the rejected value stayed in the input. The error line
  added in package 8 cleared as soon as the next save started. Card-returned
  and the punch edits had no error display at all.
- **Bib never saved (found while planning).** The bib field sent a `bib` key
  that `runner.update` did not accept; Zod stripped it and the pane said
  "Saved".

## How it was fixed

- One pending map behind one timer (`lib/runner-edits.ts`,
  `mergePendingEdits`): every field edited before the save fires goes in the
  same `runner.update`. Blur and Enter save at once, as do selects and the
  time fields. One save is in flight at a time; edits made meanwhile go in the
  next one. Closing the row saves what is still pending through the tRPC
  client directly.
- A text or number field takes the stored value only while it has no focus
  and no text that is not yet stored (`shouldSyncField`, `isSettled`).
- Client checks before sending (`validateRunnerEdits`): a blank name shows
  "Name is required" under the field and is not sent; class 0 is refused, and
  the class select offers "-" only while the runner has no class. The valid
  edits beside an invalid one are still sent.
- A refused save shows the server's message above the fields until the next
  successful save, "Saved" is hidden meanwhile, and the refused fields show
  the stored value again. Card-returned and the punch edits show their errors
  in the pane.
- `runner.update` accepts `bib`; it is stored and journaled like the other
  fields.

## Tests

- Unit: `packages/web/src/lib/__tests__/runner-edits.test.ts`.
- Integration: `runner.test.ts` stores and journals a bib with other fields.
- E2E: `e2e/runner-inline-edit.spec.ts` (two fields back to back, close right
  after typing, taken card, empty name, held refetch, bib). The taken-card,
  empty-name, back-to-back and held-refetch cases fail on the old editor.

Left out: [runner-inline-editor-followups.md](runner-inline-editor-followups.md).

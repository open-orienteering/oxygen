# ROC radio intake stalled after a reset, and the control mapping was never applied

Fix package 12 of the November 2026 full review (SYNC-05 with DB-06, API-18,
MC-30; MC-10 with DB-07, SYNC-13, API-21; SYNC-26).

## What happened

**Reset stopped radio punches for the rest of the event.** The puller
inserted each punch with a plain insert inside one transaction that also
moved the `lastId` watermark. The unique index `punches_oi_dedup_idx`
(card, code, time for `online_input` punches) rejects a punch that is
already stored, so the first old punch in a batch failed the whole
transaction, watermark included. Pressing **Reset** on the Event page sets
`lastId` to 0, which is exactly that state: every poll from then on fetched
the same range and failed the same way, and the panel showed a database
error on every tick. The tooltip promised "duplicates may appear" instead.

**A config save could roll the watermark back.** Every router mutation
(save, enable, disable, mapping, reset, the `pollNow` toggles) loaded the
whole config JSON, changed one field and wrote the whole blob back. A save
that straddled a poll commit wrote the older `lastId` back, and the next
poll imported that range a second time.

**The control mapping from the UI was dead.** The Event page writes
`mapping` into `online_input_<eventId>_config`; the puller read a separate
key, `online_input_mapping_<nameId>`, that only the integration test ever
wrote. Mapping ROC code 100 to Finish did nothing.

**One bad row blocked everything, and an HTML page looked healthy.** The
parser used `parseInt` and only checked values were positive. A row with an
id, code or card above the int4 range failed the insert (or the watermark
cast) and rolled back every tick. A 200 response that was not ROC data (an
HTML error or sign-in page) parsed to zero rows and was reported as a good
poll, clearing the error.

## The fix

- `puller.ts` inserts a poll's punches in one `createManyAndReturn({
  skipDuplicates: true })` (`ON CONFLICT DO NOTHING`) inside a transaction
  allowed 60 s, so a reset that replays a whole event does not hit the 5 s
  default and jam again. A stored punch is skipped; only stored punches are
  journaled and counted in `punches_imported`.
- `routers/onlineInput.ts` routes every config write through
  `updateConfig`, a transaction that locks the row with `SELECT … FOR
  UPDATE`. The poll's compare-and-set waits for it and re-checks the row,
  so a save can no longer rewind `lastId`.
- The puller applies `cfg.mapping` (validated by `sanitizeMapping`);
  `loadMapping` / `saveMapping` and the `nameId` key are gone.
- `roc.ts` accepts only plain positive integers up to 2,147,483,647 for id,
  code and card and returns `{ punches, skipped, maxSkippedId }`. A skipped
  row with a sound id is moved past (so a bad row at the tail is not
  refetched every poll); an out-of-range id never becomes the watermark.
  Skipped rows are counted in `rows_skipped` (`getStatus().rowsSkipped`).
  The watermark SQL casts to `bigint`.
- A body with lines but no row starting with a valid id is recorded as `Unexpected response:
  <excerpt>` and leaves `last_polled` alone, like an HTTP error.
- Tooltip (en, sv) now says Reset re-asks ROC and skips what is stored.

No migration.

## Tests

- `__tests__/online-input-roc.test.ts`: int4 limits, `12abc`-style fields,
  skipped counts, HTML and empty bodies, `sanitizeMapping`.
- `__tests__/integration/online-input.test.ts`: poll, Reset, poll again
  (old punches skipped, new one stored, no error, one journal entry per
  stored punch); mapping set and removed through the router; an
  out-of-range row between good ones; an HTML 200 then a good poll; a
  config save racing a locked watermark advance, and a poll waiting on a
  locked router write; a bad row at the tail moved past; two identical
  punches in one response; router writes on an event with no config row. The five new failure cases fail on the old code.

Left out: [roc-radio-intake-followups.md](roc-radio-intake-followups.md).

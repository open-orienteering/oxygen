# ROC radio intake: what package 12 left out

Edge cases seen while fixing [roc-radio-intake.md](roc-radio-intake.md),
left for later on purpose.

- **Peer nodes store journaled radio punches as `source: "card"`**
  (`routers/events.ts`, `punch.recorded` apply). The dedupe index only
  covers `source = 'online_input'`, so a Reset on a node that received
  radio punches through the journal (not from its own poll) could store
  them twice. Normally only the lease holder polls, which is the node that
  stored them as `online_input`.
- **Reset after a mapping change re-imports old punches under the new
  code.** The dedupe key includes the effective code, so a punch stored as
  100 and re-read after mapping 100 to Finish is stored again as 2 (the
  100 row stays). Documented in `online-input-roc.md`; arguably useful
  (retroactive finish times). Deduping on the raw code would need a
  column for it.
- **Mapped targets 1/2/3 resolve `controlId` against real controls coded
  1 to 3**, and whether the result engine treats code 2 as a finish was
  not traced. The mapping now applies, so this is worth an end-to-end
  check with a real radio finish.
- **A control deleted mid-poll** fails the foreign key on `control_id` and
  rolls back the batch for that tick; the next tick rebuilds the control
  index and succeeds. Per-row savepoints would avoid the retry.
- **`pollNow` flips `enabled` on and off** around the poll instead of
  forcing one poll, so the background reconciler may start a timer
  meanwhile. Its `fetched` figure is the id delta, not rows received.
- **Skipped rows are not shown in the panel.** They are counted in
  `rows_skipped` and returned by `getStatus().rowsSkipped`, but the Event
  page does not display the number yet.
- **A hand-edited non-integer `lastId`** (e.g. `1.5`) makes the
  watermark's `::bigint` cast throw on every poll. Only reachable by
  editing the settings row by hand.
- **Journal entries are still appended one per stored punch** inside the
  poll transaction; the punch insert itself is one statement. Fine for a
  full-event reset within the 60 s budget, but a batched journal append
  would be faster.
- **Code range.** The review suggested refusing codes of 1024 and above;
  only the int4 cap is applied, since dropping a real punch is worse than
  storing an odd code and the ranges of ROC-compatible services are not
  verified.
- **`punches_oi_dedup_idx` is not in `schema.prisma`** (it is a partial
  index, created by the init migration), so a database made with
  `prisma db push` lacks it and gets duplicates instead of skips.
- **Legacy `online_input_mapping_<nameId>` rows** are ignored, not
  migrated; nothing in the app ever wrote them.

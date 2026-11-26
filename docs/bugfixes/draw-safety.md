# Draw safety: a redraw rewrote started runners, the draw was not atomic, and Apply differed from the preview

Fix package 7 of the November 2026 full code review: RES-03, RES-09 (also DB-21, MC-42), RES-10, RES-15 (also API-22) and RES-17.

## What happened

- **RES-03.** `draw.execute` wrote a new start time and start number to every runner in the selected classes, including runners who had already finished. Results are finish minus start, so every finished runner's time changed, or went negative. The panel preselected every class, so a mid-event draw for one late class took two clicks to rewrite the whole event. A later re-read did not repair it, because the stored start wins over the card's start punch.
- **RES-15.** Preview and Apply each drew with `Math.random`, so Apply wrote a different order from the one the organiser had checked. Dragging a block in the timeline re-previewed and reshuffled every class.
- **RES-09.** Apply ran one transaction per runner and one per class, with no lock. A crash or DB error part-way left the event half on the new draw; a second Apply after a proxy timeout interleaved a different random order with the first.
- **RES-17.** Start numbers restarted at 1 on every draw, so redrawing one class duplicated another class's numbers. The `start.adjusted` journal entry did not carry the number, so peers never got it.
- **RES-10.** The first-control scheduler gave up after "bookings + 2" shifts. Two classes sharing a first control with different intervals (30 × 3:00 and 30 × 2:00, for example) ended up sending runners to the control in the same second, with no warning.

## How it was fixed

- **Protected runners.** A runner who has started is left out of the draw: a finish time, a result status (OK, MP, DNF, DQ, over max time), a read card (`cards.readout_id`, `read_count`, or a `card_readouts` row) or any stored punch. DNS, No timing, Not competing and Out of competition are often set before the start, so on their own they do not keep a runner out. The runner UPDATE repeats the finish-time and status rules, so a runner who finishes between the load and the write is not rewritten (the draw is refused as stale instead). A class's own first start and interval are rewritten only when the draw lays out the whole class. The preview and the result report how many were kept. **Also redraw runners who have started or finished** (`options.force`) brings them back in. **Only runners without a start time** (`options.mode = "onlyMissing"`) draws late entries only, appended after the class's last kept start, and leaves the class's first start and interval as they are.
- **Panel.** Only classes with no start times are preselected; classes with starts show a *drawn* badge, classes with finished runners a *started* badge. When Apply would replace start times that are already set, the panel asks first, with the count; forced redraws ask in stronger words.
- **Seeded draw.** Every random choice in `packages/api/src/draw/` comes from a seeded PRNG (`rng.ts`, mulberry32), one stream per class derived from the seed and the class seq. The preview returns its `seed` and a `previewToken` (sha256 of the seed, the options and every value Apply would write). `draw.execute` requires both, recomputes the draw from the seed inside its transaction, and refuses with `CONFLICT` "preview is stale" if the token differs. A timeline drag re-previews with the same seed.
- **One transaction.** `draw.execute` is one `$transaction` (90 s timeout plus 10 s to start, inside nginx's 120 s). It takes the per-event advisory lock that the Eventor sync and a checkout already take (`lockEventLeaseAndSync`), re-checks the lease with `mayWriteEventData`, updates every runner with one `UPDATE … FROM unnest(…)`, writes the journal with one `createMany` (`appendJournalMany`, one HLC per entry), then updates the classes. Applying the same preview twice writes the same values (in only-missing mode the retry is refused as stale instead, since the runners now have starts).
- **Start numbers.** Numbering starts at one more than the highest start number the draw does not rewrite (other classes, and kept runners). `start.adjusted` carries an optional `startNo`, and replay applies it when present; older entries leave the number alone.
- **First-control spacing.** The scheduler's bound is 100,000 shifts, and if it ever runs out the class jumps past everything booked on its control. A check after scheduling (`findFirstControlConflicts`) reports any pair of classes that still clash, pinned classes included, as a draw warning.

Tests: `packages/api/src/draw/__tests__/algorithms.test.ts`, `drawEngine.test.ts`, the RES-10 cases in `optimizer.test.ts`, `packages/api/src/__tests__/integration/draw-safety.test.ts`, and the panel cases in `e2e/draw.spec.ts`.

## Left out

- **Other classes on the first control.** A subset or only-missing draw does not book the starts of unselected classes or kept runners on the first control; it only warns when a drawn slot equals a kept start in the same class.
- **Mass-start late entries need *Simultaneous* again.** The panel opens every class on *Club separation*; for a late-entry draw in a mass-start class the organiser must pick *Simultaneous* so the late entries join the field. Many imported classes store interval 0, so it cannot be used to guess a mass start.
- **Class row with kept runners.** When a redraw keeps started runners in a class, the class's stored first start and interval are left as they were, even though the other runners move. Only the draw panel defaults and the class editor read them.
- **Write-time guard.** The runner UPDATE re-checks finish time, result status and (only-missing) start time; a card read, punch, class move or cancel committed in the same instant is not re-checked.
- **"Started" badge before the first preview** counts finish times and result statuses only; read cards and punches show up in the preview's kept count.
- **Only-missing classes on the timeline.** Late entries are pinned after the class's last start, so those classes are not shown as timeline bars and are not spaced against each other on a shared first control (a clash is still warned about).
- **Hand-set starts.** There is no `start_manual` column, so a start typed in by hand is not protected by the draw. The confirmation count and the only-missing mode cover it.
- **Zero-time starts (RES-04).** "No start time" is still `start_time = 0`. Since package 8 the draw refuses a start exactly at ZeroTime and proposes ZeroTime + 1 h ([zerotime-and-time-zone.md](zerotime-and-time-zone.md)).
- **Unique start numbers.** There is no database constraint on start numbers; the draw no longer creates duplicates, but a hand edit can.
- **RES-16** (midnight; since package 8 the draw refuses starts past 24:00) and **RES-18/RES-19** (club separation in small classes, seeded ranks) are not part of this package.
- **Timing.** A 2,000-runner draw against a remote database was not measured; the single statement and the batched journal insert should keep it well inside the timeout.

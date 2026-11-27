# Results and lists: what package 13 left out

Edge cases seen while fixing [results-and-lists.md](results-and-lists.md)
that were left for later.

- **The Eventor upload does its own standings.** `eventor.pushResults`
  still builds placements inline (the same rules: `pickRunnerCard`, free
  punches, `computeClassPlacements`). Moving it onto `loadClassStandings`
  would keep the three from drifting again.
- **Two more copies of the progress flags.** `runner.ts` (the runner list
  filters) and `event.ts` compute "has punches" / "has started" with
  slightly different punch queries; they could use `runnerProgress.ts`.
- **`runner.list` has no places.** Only the Results page and the receipt
  place runners.
- **Receipt `classResults` is always empty** from the server
  (`race.finishReceipt`), although the printer can print a top list.
- **The offline receipt on a course with NoTiming legs** cannot deduct
  peers' legs (their punches are not in the cache), so its position is
  best-effort until the server answers.
- **Kiosk printing before `applyResult` resolves.** The receipt now
  substitutes the runner's own readout, so the numbers agree, but the kiosk
  still prints on the first answer.
- **Timed OutOfCompetition / NoTiming runners on Eventor** go up as
  `NotCompeting` / `OK` as before; whether MeOS sends `OK` with a time for
  them was not checked.
- **Unknown → Active uses the time of day only.** A runner whose drawn start
  has passed but who never started goes up as `Active` until a DNS is set,
  and the event date is not compared: an upload the next morning before the
  first start reports unread runners as `Inactive`. Whether Eventor's import
  accepts `Active` / `Inactive` / `Finished` has not been tried against
  Test-Eventor yet.
- **The Star raster builder has no Fin-row test.** It uses the same
  `finish` entry as the ESC/POS builder, which is tested.
- **The offline receipt has no finish-leg length** (leg lengths are not in
  the dashboard cache), so its Fin row prints the split without a pace.
- **The finish split is the raw run-in.** No NoTiming deduction applies to
  the finish leg itself.
- **Expected positions are resolved per request** (one query per course on
  each result list and receipt); a cache across requests would help large
  events.

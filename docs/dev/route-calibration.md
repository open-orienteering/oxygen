# Calibrating the route cost model

The route finder's estimated times come from a cost model: how fast each
kind of terrain is run relative to forest, and what a slope costs
(`course-elevation.md` §7.7). The numbers can be fitted to GPS tracks of
real runs with a local command (`course-elevation.md` §7.9).

## What you need

- The **map file** of each race (`.ocd`, `.omap` or `.xmap`), georeferenced.
- **Track records** for it: JSON files of courses (controls in WGS 84) and
  finishers' tracks with times (`course-elevation.md` §7.9.1). Where they
  come from is up to you; the command reads the neutral shape only. Pick
  the runners before: the command fits every `ok` track it is given, and
  the best tenth of each class is what the model is meant for.
- Node 22.12 or newer and the repository installed (`pnpm install`).

## Running it

```bash
pnpm --filter @oxygen/api route:calibrate \
  --map ~/maps/race-1.ocd --tracks ~/tracks/race-1/ \
  --map ~/maps/race-2.ocd --tracks ~/tracks/race-2/ \
  --out ~/calibration-report.json --id forest-2026-1
```

Each `--tracks` (one record, or a directory of `*.json` records) belongs
to the `--map` before it. `--no-heights` skips the contour field (no slope
is read). The run needs no database and no server and sends nothing
anywhere. It prints a summary and writes the report.

## What is private and what is not

Tracks are personal data, and a map may not be yours to publish. Keep
both outside the repository. The **report** holds aggregates only — metres
and seconds per terrain class, counts, errors, the fitted numbers — no
coordinate, no time of day, no name, no file name, and it is safe to
share. Never commit a track record or a map; no test fixture holds a real
track (the tests run made-up runners on made-up terrain).

## Reading the report

- `classes[]`: per terrain class, what it rests on (`metres`, `runners`,
  `legs`), the rule-of-thumb `baseFactor`, the fitted `factor` with its
  90 % `interval`, and `calibrated`. `kept` says why a class kept the rule
  of thumb: `no-track`, `little-track`, `not-settled` (the interval is too
  wide) or `anchor` (the class the others are measured against).
- `alongTrack`: the error of predicted leg times on legs held out of the
  fit, for the fitted model and for the rule of thumb. The fitted one
  should be lower.
- `againstFinder.median`: actual leg time over the finder's fastest route
  at the runner's pace. Near 1 is good; well under 1 means runners find
  faster ways than the finder (a bridge or passage the grid does not
  hold); well over 1 means the finder is optimistic.
- `maps[].medianMissM`: metres between a control and where tracks pass
  it. Over about 10 m suggests the map's georeference is off.
- `counts.rejected`: legs left out, per reason.

## Adopting a model

When the report is good enough — the held-out error no worse than the
rule of thumb, `againstFinder.median` between about 0.97 and 1.15 — copy
its `model` block into `COST_MODELS` in
`packages/shared/src/route/cost-model.ts` under its id and name the id in
`CURRENT_COST_MODEL_IDS` for the map family it was fitted on (`sprint` or
`forest`). `default-1` stays. The editor's note then names the measured
terrain.

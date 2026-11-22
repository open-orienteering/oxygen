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
anywhere. It prints its progress and a summary and writes the report. A
forest map with many classes takes minutes. Under five runs with a usable
leg on any one map it writes nothing. `--id` ends up in the report:
give the model a neutral name (`sprint-2026-1`), not an event's or a
club's.

## What is private and what is not

Tracks are personal data, and a map may not be yours to publish. Keep
both outside the repository. The **report** holds aggregates only — metres
and seconds per terrain class, counts, errors, the fitted numbers — no
coordinate, no time of day, no name, no file name, and it is safe to
share. Never commit a track record or a map; no test fixture holds a real
track (the tests run made-up runners on made-up terrain).

## Reading the report

- `classes[]`: per terrain class, what it rests on (`metres`, `runners`,
  `legs`, `pairs` — different control pairs), the rule-of-thumb
  `baseFactor`, the fitted `factor` with its 90 % `interval`, and
  `calibrated`. `kept` says why a class kept the rule of thumb:
  `no-track`, `little-track` (under 2000 m, 10 runs, 30 legs or 8 control
  pairs), `not-settled` (the interval is too wide) or `anchor` (the class
  the others are measured against). The `model` block holds a fitted
  factor only for a `calibrated` class; for the others it holds the rule
  of thumb, whatever `factor` says here.
- `converged`: the fit settled. If `false`, nothing is measured; more
  varied legs are needed.
- `alongTrack`: the error of predicted leg times on legs held out of the
  fit, for the model as it would be adopted (measured numbers only) and
  for the rule of thumb. The fitted one should be lower.
- `againstFinder.median`: actual leg time over the finder's fastest route
  at the runner's pace. It is about 1 or more by construction, so it
  cannot confirm a model; it is a smoke test. Well under 1 (or a large
  `shareUnder095`) means runners take ways the grid does not hold (a
  bridge, a passage); well over 1 means runners do not take the routes
  the model calls fastest.
- `maps[].medianMissM`: metres between a control and where tracks pass
  it. Over about 10 m suggests the map's georeference is off.
- `counts.rejected`: legs left out, per reason. No leg is left out for
  being slow; `counts.outliers` are the legs the fitted model misses by
  more than a factor of two (mistakes, mostly), which weigh little.

## Adopting a model

When the report is good enough — the classes that matter `calibrated`,
the held-out error clearly lower than the rule of thumb's, its `bias`
near zero, and `againstFinder` showing nothing odd — copy
its `model` block into `COST_MODELS` in
`packages/shared/src/route/cost-model.ts` under its id and name the id in
`CURRENT_COST_MODEL_IDS` for the map family it was fitted on (`sprint` or
`forest`). `default-1` stays. The editor's note then names the measured
terrain.

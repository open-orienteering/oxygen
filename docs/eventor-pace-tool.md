# Eventor pace tool

Read-only CLI for estimating how fast each entrant of an Oxygen event is,
from their results in past Eventor events. The primary use case is the start
draw: slow runners should not be placed at the end of their class, because
that keeps the whole finish waiting.

The tool lives in two pieces:

- [`packages/api/src/eventor-pace.ts`](../packages/api/src/eventor-pace.ts) —
  pure parsing and scoring (unit-tested)
- [`scripts/eventor-pace.ts`](../scripts/eventor-pace.ts) — CLI that reads the
  Oxygen start list, fetches Eventor result lists, prints a table and optional
  CSV

Nothing is written back to Oxygen or Eventor.

## Quick start

```bash
# 1. Find the Eventor ids of the rounds you want to learn from
pnpm tsx scripts/eventor-pace.ts --discover Ungdomsserien

# 2. (Optional) Inspect one event's XML before committing to a long fetch
pnpm tsx scripts/eventor-pace.ts --probe 54320

# 3. Run the report
pnpm tsx scripts/eventor-pace.ts \
  --event Ungdomsserien_regionfinal_SO \
  --history 54320,56939,58627,54100,56757,56768,57313,58518 \
  --csv /tmp/pace.csv
```

The API key is read from `oxygen.settings` (`eventor_api_key` for prod,
`eventor_api_key_test` for test) unless `EVENTOR_API_KEY` is set.

## What the columns mean

| Column | Meaning |
|--------|---------|
| **Races** | Finished races in the history set that produced a usable time |
| **Ratio** | Median of (runner time ÷ class median time) across those races. 1.0 = exactly average for the field they ran against; 1.5 = 50 % slower |
| **min/km** | Median pace, but only for races where Eventor carried a course length |
| **Est** | Predicted finish on *this* event's course: ratio × class target pace × course length |
| **DNF** | Races in the history set that did not finish (mispunch, DNF, DNS) |
| **Seed** | `round(1000 / ratio)` — higher = faster = starts later, matching Oxygen's `seededDraw` sort |

Within each class the table is sorted **slowest first**, which is the
suggested start order: put the slow runners out early so the class finish
compresses.

Runners with no usable history get seed **1000** (the class median) so they
are neither first nor last.

## How scoring works

### Why ratio, not raw minutes

Terrain, weather and course setting move everyone's times together. A 45-minute
run on a hard forest course is not comparable to 45 minutes on a flat park
sprint. What *is* comparable is how a runner did relative to the rest of their
class that day.

For each race:

```
ratio = runner_time_sec / median(finisher_times_in_class)
```

Across races we take the **median** ratio, because one bad leg or a long
hesitation is not evidence that someone is slow.

### Course length and pace

Eventor exposes two result-list endpoints:

| Endpoint | Dialect | Times | Course length |
|----------|---------|-------|---------------|
| `results/event/iofxml` | IOF 3.0 | seconds | yes, when the uploader supplied it |
| `results/event` | Eventor 2.0.3 | `mm:ss` clock strings | never |

The CLI prefers IOF 3.0 and falls back to 2.0.3. In practice the 2026
Ungdomsserien rounds all came back via IOF 3.0 with lengths on every class.

When a length is present, min/km is computed from the runner's own course
(person-level override applied for forked classes). The **Est** column uses the
median pace an average runner of that class name held across the history
events, scaled by the runner's ratio and this event's course length from
Oxygen.

When lengths are missing, ratio still works; min/km and Est are blank.

### Class changes

Ratios are class-relative, so a runner who moved from H12 to H14 aggregates
cleanly — each race is scored against its own class median.

## Eventor person ids

Runners are keyed by Eventor `PersonId` (IOF 3.0: `Person/Id type="Eventor"`;
2.0.3: `Person/PersonId`). Oxygen stores this in `runners.eventor_person_id`
after an Eventor entry import. Entrants without a person id are skipped in the
history lookup and appear with `-` in the report.

## Caching

Raw XML responses are cached under `.eventor-cache/` (gitignored). Finished
events never change, so reruns are instant. Pass `--no-cache` to bypass.

## Wiring into the draw

Oxygen's seeded draw reads `runners.rank` (currently unused — all zeros in the
target event). To use this report:

1. Run the tool and review the per-class ordering.
2. Assign `rank = seed` from the CSV (higher = faster = starts later).
3. Run a seeded draw in the Draw panel.

A future UI integration could fetch history and populate ranks automatically;
this script is deliberately standalone so you can sanity-check the numbers
before trusting them in a live draw.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | local dev Postgres | Oxygen database |
| `EVENTOR_API_KEY` | — | Overrides the key from `settings` |
| `EVENTOR_ENV` | `prod` | `prod` or `test` |
| `EVENTOR_API_BASE_URL` | — | Point at a stub (E2E only) |
| `PACE_CACHE_DIR` | `.eventor-cache` | XML cache directory |

## Example probe output

```
pnpm tsx scripts/eventor-pace.ts --probe 54320

results/event/iofxml
  dialect:        3.0
  results:        100
  with person id: 95
  with a length:  100
  classes:        11

results/event
  dialect:        2.0.3
  results:        100
  with person id: 95
  with a length:  0
```

Use `--probe` when evaluating a new series or before trusting the Est column
for an unfamiliar organiser.

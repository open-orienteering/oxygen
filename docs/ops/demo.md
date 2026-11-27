# Try Oxygen in Cloud Shell

Oxygen is a lightweight orienteering competition management system. This tutorial gets you a fully working instance in about two minutes — no local setup needed.

## Step 1: Start the app with demo data

This script pulls the published multi-architecture GHCR image, starts
PostgreSQL 18, applies the `oxygen` migrations from that image, loads the
**Demo Competition** showcase, and starts the full app. Only Docker with the
Compose plugin is required — Cloud Shell does not need Node.js, pnpm, or a
dependency install:

```bash
bash scripts/demo.sh
```

The demo defaults to `ghcr.io/open-orienteering/oxygen:edge`, the newest
`main` build that passed the image smoke. To test a release or immutable build:

```bash
OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:v1.2.3 bash scripts/demo.sh
# or: OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:sha-<full-commit> ...
```

The first run takes a minute while Docker pulls the image.

## Step 2: Open the app

Click **Web Preview** (the icon in the top-right of Cloud Shell) and select port **8080**.

You'll land on the Demo Competition — a fully populated, anonymized showcase derived from a Swedish forest race: 5 classes, 169 runners across 38 clubs, completed runs with splits, and 2 700+ radio/finish punches. The map is a Swedish forest south of Stockholm from [o-kartan.se](https://o-kartan.se), licensed to the project, with invented boulders and landforms ([see "The map"](#the-map)). The race's controls were moved onto it afterwards, so the courses are real but the terrain under them is not where the race was run. The map loads like any uploaded map (source, imported document, the event's pin), so the map, the courses and the overprint draw as on any event. The fixture currently has no GPS tracks, routes or saved course sheets; Layout mode's **Create sheet** makes one from the default template in one click (the showcase screenshot run does exactly that). Everything is pre-wired so you can explore:

- **Runners / Start list / Results** — full field with classes, clubs, start times and splits
- **Courses** — controls and legs on the demo map
- **Cards** — process SI card readouts against the existing field
- **Kiosk** — open in a second tab for the self-service registration view

## Step 3: Reload the showcase (optional)

The showcase fixture lives at `fixtures/showcase/showcase.sql`, with its map in `fixtures/okartan/okartan-demo.ocd`, and is loaded by `scripts/load-showcase.sh` / `pnpm showcase:load`. The load is idempotent — it cascade-deletes any existing `demo_competition` event before re-inserting, so re-running is safe:

```bash
# Reload into the Cloud Shell docker PostgreSQL
COMPOSE_FILE=docker-compose.release.yml USE_DOCKER=1 \
  bash scripts/load-showcase.sh

# Reload into a native PostgreSQL on your host
pnpm showcase:load
```

### The map

The demo map is a cut of a Swedish forest south of Stockholm, bought from
[o-kartan.se](https://o-kartan.se) by the project maintainer and licensed
for any use, including publishing it here. o-kartan makes its maps
automatically from Lantmäteriet's laser scan: OCAD 12, ISOM 2017-2,
1:15 000, about 2.6 × 3.2 km. The demo version adds invented boulders,
landforms and cliff tags, which are not surveyed. [demo-map.md](demo-map.md)
has the source, the licence and how the invented detail is made:

| File | What it is |
|---|---|
| `fixtures/okartan/okartan-original.ocd` | The map as bought |
| `fixtures/okartan/okartan-demo.ocd` | The demo map: the original plus the invented detail |

No club map, and no map from the source event, is in the fixture. Club
maps of the same forest exist and stay out of git
([screenshots/README.md, "Private maps"](../screenshots/README.md#private-maps)).

Until 2026-11 the demo used the CC0 Puit de Laven map by David Kaplan
([github.com/dmkaplan2000/orienteering-maps](https://github.com/dmkaplan2000/orienteering-maps)).
It stays in `fixtures/showcase/` as a test map: `puit-de-laven.omap` as
published, and `puit-de-laven-demo.omap` with 358 invented point features
from `node scripts/inject-demo-points.mjs` (seed 42,
`scripts/lib/inject-demo-points.mjs`, tested by
`scripts/__tests__/demo-map.test.mjs`).

### How the fixture holds the map

The fixture is written for the current schema (v0.6.1 and later). The
2 MB source and its document would be several MB of hex in the SQL,
so the SQL carries **no map bytes**. It holds one `map_files` row that
names the demo map by its source hash (`source_hash`, SHA-256 of
`okartan-demo.ocd`) with `document_hash` NULL. `load-showcase.sh`
then does three things in order:

1. checks that the committed `.ocd` hashes to the fixture's
   `source_hash`, and inserts its `map_sources` row (sent base64-encoded
   on psql's stdin, `ON CONFLICT DO NOTHING`);
2. runs `showcase.sql`;
3. runs the map re-match for `demo_competition`
   (`docs/map-storage.md` §6.9, reason `unpinned`): it imports the
   document, pins it with the pin's quick-access columns (`scale`,
   `bounds`, `north_offset`, `calibration`) and derives the controls'
   `lat` / `lng`. Natively this is `pnpm map:rematch`; under `USE_DOCKER=1`
   it is the API image's own CLI
   (`docker compose exec <api> node packages/api/dist/cli/map-rematch.js`),
   so the Cloud Shell demo still needs no Node on the host.

The loader fails if the map is not pinned at the end. The document is
always made by the importer of the image that serves it, so an importer
or symbol-library release needs no re-pin of the fixture.
`scripts/__tests__/showcase-map.test.mjs` and
`packages/api/src/__tests__/integration/showcase-fixture.test.ts` cover
this: no map bytes in the SQL, the source hash, the pin after loading,
`course.mapMetadata`, and a second load giving the same state.

### Controls on the demo map

The controls, courses, runners and punches come from the source race;
codes and sequences are unchanged, so results and splits stay valid. Only
the control **positions** belong to the demo map. They live in
`fixtures/showcase/showcase-controls.json`, one line per control,
keyed by `seq` (paper mm in the map document's frame; `0, 0` means not
placed). `scripts/showcase-controls.mjs apply` writes them into
`showcase.sql`. It also clears `lat` / `lng` (the pin derives them on
load) and the courses' stored `structure`, whose site ids named the source
event's controls. It re-derives each course's `legs` / `length_m` the
way the course editor does after a move (`length_source = 'derived'`).

The placement is made by `node scripts/showcase-controls.mjs fit <a
fixture with positions> --max-scale 0.6`, run once on the fixture as it
stood on the Puit de Laven map (whose positions were the source race
turned a quarter turn and scaled ×1.36 at 1:10 000):

- **Fit:** the control cloud is turned (each quarter turn is tried),
  scaled by at most `--max-scale` and slid over the map in 2 mm steps.
  The kept placement has no control in a forbidden area (water, fight,
  cultivated land, paved areas, out-of-bounds, buildings) or within
  12 mm (180 m) of the drawn map's edge, then the fewest legs through
  uncrossable water, marsh, out-of-bounds or a building, then the most
  controls on a feature, then the least movement. ×0.6 is the largest
  scale at which the courses fit with at most two such legs; the courses
  are about 0.8 of the source race's length (A 5.3 km).
- **Snap:** each control moves to the nearest free boulder, knoll,
  depression or pit within 6 mm (90 m) that is at least 4 mm (60 m) from
  the controls already placed, and each start and finish onto the nearest
  path or road.

It keeps the courses' shape, not the course setter's intent: two legs
still cross water, and a control may stand on a feature a setter would
not pick. To place the controls by hand:

1. Load the fixture into a database you can edit, with the app running
   on it, e.g. your local checkout:
   ```bash
   pnpm showcase:load        # dev database on :5432, then `pnpm dev`
   ```
2. Open **Demo Competition → Courses** and move controls in the course
   editor. A new control, or a change to a course's controls, is
   captured by `showcase-course.mjs export` ([below](#the-showcase-course));
   `apply` takes only the positions of the controls `showcase.sql` has.
3. Capture the positions back into the fixture:
   ```bash
   DATABASE_URL='postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen' \
     node scripts/showcase-controls.mjs export     # writes showcase-controls.json
   node scripts/showcase-controls.mjs apply        # patches showcase.sql
   pnpm test:scripts
   ```
   `export` (and `fit`) list any control that sits in water, cultivated
   land, a paved area or a building, or outside the mapped area.
4. Commit `showcase-controls.json` and `showcase.sql` together. Then
   `pnpm showcase:load` again, to see the result as the demo will.

Repeat steps 2–3 as often as you like; `apply` is idempotent.

### The showcase course

Besides the race's five courses, the demo has a course named **Showcase**
that is there to show the course editor: a three-way fork after control 2,
a butterfly loop at control 6 (A and B, both orders), a corridor over
the two legs into controls 13 and 14, an out-of-bounds area and a printed
sheet. Its 3 fork branches times the loop's 2 orders give 6 variants
(*Showcase AAB* … *Showcase CBA*). It has no runners. Its own controls
have codes from 101 up, its start code 3 and its finish code 4; its last
control is the race's 64. The race's start and finish have codes 5 and 6.

It lives in `fixtures/showcase/showcase-course.sql`, which
`load-showcase.sh` runs right after `showcase.sql`. The file is exported
from a database, never edited by hand, and holds the event's whole course
setup as the course editor left it, the race's courses included:

1. `pnpm showcase:load` into a database you can edit, with the app on it,
   and open **Demo Competition → Course Editor**.
2. Edit the courses: move controls, change the fork or the loop, draw
   objects, lay out the sheets, change a race course's controls.
3. Point every course at its own start and finish and give the starts and
   finishes codes, then write it all back:
   ```bash
   export DATABASE_URL='postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen'
   pnpm exec tsx scripts/showcase-start-finish.mts   # through the API
   node scripts/showcase-course.mjs export          # writes showcase-course.sql
   node scripts/showcase-controls.mjs export        # the race's positions, for its checks
   node scripts/showcase-controls.mjs apply
   pnpm test:scripts
   ```

`showcase-start-finish.mts` gives each live start and finish without a
code the lowest free one in 3–10 (the rule `control.create` follows), then
sets the *Showcase* course to start and finish at the start and finish
that are not the race's (their `seq` is not in `showcase.sql`) and every
other course at the race's, through `course.setStructure`, so lengths and
variants follow. It stops if there is not exactly one of each.

`export` writes every control and course of the event as an upsert on
`id`, so the race's rows in `showcase.sql` take the editor's codes,
positions, starts and sequences; every course's `course_controls` in place
of `showcase.sql`'s; the course objects; the sheets (without the
instance's print template); and the event's seq counters raised past
every row, so the next control or course the editor creates takes a free
`seq`. The race's results stay `showcase.sql`'s: a race course whose
controls change no longer matches its runners' punches.

`showcase-controls.json` and `showcase.sql` keep the race's positions
for the placement checks (on a feature, clear of water and the edge);
export them too after moving a race control. The first version of the
showcase course was set by a script through the API and snapped onto the
map's features.

### Tests

| Level | File | Covers |
|---|---|---|
| Script | `scripts/__tests__/showcase-map.test.mjs` | the source is the committed `.ocd` (kind `ocad`); it imports at 1:15 000 and its document names this source; the source-only `map_files` row, the E-demo block replaced; the committed fixture has no map bytes or dropped storage, one map, named by the demo map's hash, which is on the public-map list beside the original's; nothing of the source map or its club, in the SQL or in the map's 8-bit and UTF-16 strings |
| Script | `scripts/__tests__/showcase-controls.test.mjs` | SQL value splitting; the fixture's 37 controls (unique `seq`), 5 courses, 62 course controls; the fit (one rotation and scale, a fixed quarter turn, inside the margin, unplaced kept, scale capped, deterministic); snap (nearest free feature within reach, starts and finishes onto a path, `spacing` and one control per feature, a control with nothing in reach kept); place (no leg through the lake, nothing in it or near the edge, every control on a feature, the scale kept, deterministic); the course legs; the demo map's region, forbidden areas, features, paths and slanted edge; the committed positions on features (starts and finishes on paths), 60 m apart, clear of forbidden areas and the edge, with the two documented legs across water; `apply` (positions, `lat` / `lng` and `structure` NULL, legs and length re-derived, idempotent, mismatched files refused); the committed fixture holds the committed positions; `export` through a stub client |
| Script | `scripts/__tests__/demo-map.test.mjs` | the Puit de Laven test map's injection (it is no longer the demo's map) |
| Script | `scripts/__tests__/release-compose.test.mjs` | under `USE_DOCKER=1` the loader re-matches with the image's CLI and no host `pnpm` / Node; the source travels base64 on stdin; the map file is the o-kartan demo map, kind `ocad` |
| Unit (api) | `packages/api/src/__tests__/demo-map-enrich.test.ts` | the demo map's invented detail ([demo-map.md](demo-map.md#tests)) |
| Script | `scripts/__tests__/showcase-course.test.mjs` | a row's `json_populate_record` line reads back the same (quotes, backslashes; lat / lng cleared), controls and courses as upserts on `id`; `export` through a stub client (every control and course, the course controls replaced after the courses, objects, sheets without the instance template, the seq counters, no Showcase course refused); `withEnds` (another start or finish replaced, the leg into the finish kept, missing ends added, a control run as start or finish kept, a leading group); the committed file: the race's courses and controls, the Showcase course, its variants and sheet in the demo event, every control it names written by the file, every start and finish coded with no code shared, the Showcase course at its own start and finish and every other at the race's, no source names; the loader runs it after `showcase.sql` |
| Integration (api) | `packages/api/src/__tests__/integration/showcase-fixture.test.ts` | load as the loader does, pin at 1:15 000 south of Stockholm, `course.mapMetadata`, control `lat` / `lng`, race courses from the coded race start to the race finish, lengths equal `rebuildCourseLengths`, the showcase course (both groups, 6 variants, corridor, out-of-bounds area, sheet, controls pinned), a second load (`docs/map-storage.md` §10) |

### Pending

- The control positions are the automatic placement above; hand placement in the course editor is the user's, for the race's courses and the showcase course alike. The screenshots still feature course A until the showcase course is tweaked.
- No GPS tracks, routes or printable course sheets in the fixture.

### Regenerate from your own Vinterserien data

To regenerate the whole fixture from your own Vinterserien event (rewrites `fixtures/showcase/showcase.sql` in place), point the anonymiser at a database that is at the **current schema**. The anonymiser reads the source strictly read-only but copies every column of the source tables, so it refuses a pre-v0.6.1 database. From a dump of an older database, restore it into a scratch database first and migrate that copy:

```bash
createdb oxygen_vinterserien_src
pg_restore --no-owner --no-privileges -d oxygen_vinterserien_src my-oxygen.dump
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5432/oxygen_vinterserien_src?schema=oxygen' pnpm db:migrate
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5432/oxygen_vinterserien_src?schema=oxygen' \
  pnpm tsx scripts/anonymize-vinterserien.ts
dropdb oxygen_vinterserien_src
```

(`pnpm db:migrate` on a restored copy applies the E5 drops, whose guard needs every live event's map to have its bytes in `map_sources` — true once the v0.6.0 backfill has been run on it (Settings → Maintenance → Map documents, or `scripts/gcp/backfill.sh`); the guard's error message says so if not.) With a current-schema database you can skip the restore and run the anonymiser on it directly. Override `SRC_NAME_ID` to point at a different source event.

The anonymiser pseudonymises runners, remaps card numbers, scrubs the event's contact and Eventor fields, and replaces the source map entirely with the demo map's `map_files` row above (only the source row's `uploaded_at` and `rotation_correction` carry over). It then applies `showcase-controls.json`, so a regenerated fixture has the committed control positions.

## Step 4: Connect your own data (optional)

**If you have an Eventor account** (Swedish orienteering clubs):

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → **API key**
2. In Oxygen, go to **Settings** → paste the API key
3. Your real competitions, entries, and clubs will sync automatically

---

For local development setup, see the [README](../../README.md).

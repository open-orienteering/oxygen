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

The demo defaults to `ghcr.io/open-orienteering/oxygen:edge`, the latest
verified `main` build. To test a release or immutable build:

```bash
OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:v1.2.3 bash scripts/demo.sh
# or: OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:sha-<full-commit> ...
```

The first run takes a minute while Docker pulls the image.

## Step 2: Open the app

Click **Web Preview** (the icon in the top-right of Cloud Shell) and select port **8080**.

You'll land on the Demo Competition — a fully populated, anonymized showcase derived from a Swedish forest race: 5 classes, 169 runners across 38 clubs, completed runs with splits, and 2 700+ radio/finish punches. The map is **Puit de Laven**, a forest near Montpellier, France, by David Kaplan, published under CC0-1.0 ([see "The map"](#the-map)). The race's controls were moved onto it afterwards, so the courses are real but the terrain under them is not where the race was run. The map loads like any uploaded map (source, imported document, the event's pin), so the map, the courses and the overprint draw as on any event. The fixture currently has no GPS tracks, routes or printable course sheets. Everything is pre-wired so you can explore:

- **Runners / Start list / Results** — full field with classes, clubs, start times and splits
- **Courses** — controls and legs on the demo map
- **Cards** — process SI card readouts against the existing field
- **Kiosk** — open in a second tab for the self-service registration view

## Step 3: Reload the showcase (optional)

The showcase fixture lives at `docs/screenshots/fixtures/showcase.sql`, with its map `puit-de-laven-demo.omap` beside it, and is loaded by `scripts/load-showcase.sh` / `pnpm showcase:load`. The load is idempotent — it cascade-deletes any existing `demo_competition` event before re-inserting, so re-running is safe:

```bash
# Reload into the Cloud Shell docker PostgreSQL
COMPOSE_FILE=docker-compose.release.yml USE_DOCKER=1 \
  bash scripts/load-showcase.sh

# Reload into a native PostgreSQL on your host
pnpm showcase:load
```

### The map

The demo map is **Puit de Laven** by **David Kaplan**, from
[github.com/dmkaplan2000/orienteering-maps](https://github.com/dmkaplan2000/orienteering-maps)
(`puit-de-laven/puit-de-laven.omap`, commit `38f674c`), released under
**CC0-1.0**, a public-domain dedication. Thank you for publishing it. It is
an OpenOrienteering Mapper file at 1:10 000, georeferenced in UTM zone 31N,
of a forest near Montpellier.

The published map has hardly any point features, so the demo adds some.
**The 358 boulders, knolls, depressions and pits on the demo map are
invented**: they sit at seeded random positions in forest and open land,
clear of every line and of each other, and are not surveyed. Each one is
tagged `oxygen-demo=injected` in the Mapper file, and the map's notes say
so. The original is committed unchanged as
`docs/screenshots/fixtures/puit-de-laven.omap`; the demo map
`puit-de-laven-demo.omap` next to it is made from it by

```bash
node scripts/inject-demo-points.mjs        # seed 42; reproduces the committed file
node scripts/patch-showcase-map.mjs        # after changing the seed or the plan: rewrite the demo map and re-pin the fixture
```

(140 × 204 boulder, 30 × 205 large boulder, 18 × 207 boulder cluster,
90 × 109 small knoll, 25 × 110 elongated knoll, 30 × 111 small depression,
25 × 112 pit; `scripts/lib/inject-demo-points.mjs`). The placement was first
made and approved with a Python script; the Node port reproduces Python's
random generator, so the committed file is that approved placement byte
for byte. `scripts/__tests__/demo-map.test.mjs` checks the original's
hash against the upstream file, the demo map against the script's
output, the counts, tags and note, and that nothing else in the map
changes. No club map, and no map from the source event, is in the
fixture.

### How the fixture holds the map

The fixture is written for the current schema (v0.6.1 and later). The
5 MB source and its 1.2 MB document would be over 12 MB of hex in the SQL,
so the SQL carries **no map bytes**. It holds one `map_files` row that
names the demo map by its source hash (`source_hash`, SHA-256 of
`puit-de-laven-demo.omap`) with `document_hash` NULL. `load-showcase.sh`
then does three things in order:

1. checks that the committed `.omap` hashes to the fixture's
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
`docs/screenshots/fixtures/showcase-controls.json`, one line per control,
keyed by `seq` (paper mm in the map document's frame; `0, 0` means not
placed). `scripts/showcase-controls.mjs apply` writes them into
`showcase.sql`. It also clears `lat` / `lng` (the pin derives them on
load) and the courses' stored `structure`, whose site ids named the source
event's controls. It re-derives each course's `legs` / `length_m` the
way the course editor does after a move (`length_source = 'derived'`).

The first placement is a fit: the source race's control cloud turned a
quarter turn and scaled ×1.36 (1.5 would keep the terrain lengths of the
1:15 000 original) to fit the map 15 mm inside its edge
(`node scripts/showcase-controls.mjs fit <a fixture with the source
positions>`). It keeps the courses' shape, not the terrain: a control
can stand on a path or in thicket. To place the controls by hand:

1. Load the fixture into a database you can edit, with the app running
   on it, e.g. your local checkout:
   ```bash
   pnpm showcase:load        # dev database on :5432, then `pnpm dev`
   ```
2. Open **Demo Competition → Courses** and move controls in the course
   editor. Only move existing controls: adding one, or changing a course's
   control sequence, is not captured (the race data is fixed), and
   `apply` refuses a control the fixture does not have.
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

### Tests

| Level | File | Covers |
|---|---|---|
| Script | `scripts/__tests__/demo-map.test.mjs` | `PyRandom` against CPython's draws; the original's hash is the upstream file's; the injection reproduces the committed demo map byte for byte, deterministic, seed-dependent; per-symbol counts, every object tagged, only 110 rotated; nothing else changes (removing the objects and the note gives the original); the note; every feature inside the region, clear of lines, forbidden areas and other points |
| Script | `scripts/__tests__/showcase-map.test.mjs` | the source facts; the import resolves EPSG:32631 at 1:10 000 and gives the pin's columns; the source-only `map_files` row, the E-demo block replaced; the committed fixture has no map bytes or dropped storage, one map, named by the hash of the injection's output on the upstream file, and nothing of the source map or its club |
| Script | `scripts/__tests__/showcase-controls.test.mjs` | SQL value splitting; the fixture's 37 controls (unique `seq`), 5 courses, 62 course controls; the fit (one rotation and scale, inside the margin, unplaced kept, scale capped at 1.5, deterministic); the demo map's region and forbidden areas; `apply` (positions, `lat` / `lng` and `structure` NULL, legs and length re-derived, idempotent, mismatched files refused); the committed fixture holds the committed positions; `export` through a stub client |
| Script | `scripts/__tests__/release-compose.test.mjs` | under `USE_DOCKER=1` the loader re-matches with the image's CLI and no host `pnpm` / Node; the source travels base64 on stdin |
| Integration (api) | `packages/api/src/__tests__/integration/showcase-fixture.test.ts` | load as the loader does, pin, `course.mapMetadata`, control `lat` / `lng`, course sequences and lengths equal `rebuildCourseLengths`, a second load (`docs/map-storage.md` §10) |

### Pending

- The control positions are the first fit; hand placement in the course editor (above) is the user's.
- No GPS tracks, routes or printable course sheets in the fixture.

### Regenerate from your own Vinterserien data

To regenerate the whole fixture from your own Vinterserien event (rewrites `docs/screenshots/fixtures/showcase.sql` in place), point the anonymiser at a database that is at the **current schema**. The anonymiser reads the source strictly read-only but copies every column of the source tables, so it refuses a pre-v0.6.1 database. From a dump of an older database, restore it into a scratch database first and migrate that copy:

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

For local development setup, see the [README](../README.md).

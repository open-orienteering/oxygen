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

You'll land on the Demo Competition — a fully populated, anonymized showcase derived from a Swedish forest race: 5 classes, 169 runners across 38 clubs, completed runs with splits, and 2 700+ radio/finish punches. The map is a generated synthetic OCAD with a SWEREF99 TM georeference matching the course data; the fixture carries it on the document pipeline (its source, the imported map document and the event's pin), so the map, the courses and the overprint draw as on any event, with synthetic terrain. The fixture currently has no GPS tracks, routes or printable course sheets. Everything is pre-wired so you can explore:

- **Runners / Start list / Results** — full field with classes, clubs, start times and splits
- **Courses** — controls and legs on the demo map
- **Cards** — process SI card readouts against the existing field
- **Kiosk** — open in a second tab for the self-service registration view

## Step 3: Reload the showcase (optional)

The showcase fixture lives at `docs/screenshots/fixtures/showcase.sql` and is loaded by `scripts/load-showcase.sh` / `pnpm showcase:load`. The fixture is idempotent — it cascade-deletes any existing `demo_competition` event before re-inserting, so re-running is safe:

```bash
# Reload into the Cloud Shell docker PostgreSQL
COMPOSE_FILE=docker-compose.release.yml USE_DOCKER=1 \
  bash scripts/load-showcase.sh

# Reload into a native PostgreSQL on your host
pnpm showcase:load
```

### How the fixture holds the map

The fixture is written for the current schema (v0.6.1 and later). Its map is the generated synthetic OCAD (`scripts/lib/ocad-fixture.mjs`; a real map export is never committed), stored the way the app stores an uploaded map (`docs/map-storage.md`):

- a `map_sources` row with the OCAD bytes,
- a `map_documents` row with the document the importer makes of them (`scripts/lib/showcase-map.mjs` runs the API's own import, so no re-match is needed after loading),
- the event's `map_files` row, pinning both with the pin's quick-access columns (`scale`, `bounds`, `north_offset`, `calibration`).

The two content-addressed rows load with `ON CONFLICT DO NOTHING`, so reloading never fails or overwrites. The document records the importer and symbol-library release that made it; when either changes, `scripts/__tests__/showcase-map.test.mjs` fails until you re-pin the committed fixture:

```bash
node scripts/patch-showcase-map.mjs
```

This rewrites only the three map INSERTs; nothing else in the fixture changes.

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

The anonymiser pseudonymises runners, remaps card numbers, scrubs the event's contact and Eventor fields, and replaces the source map entirely with the synthetic map rows above (only the source row's `uploaded_at` and `rotation_correction` carry over). Run `node scripts/patch-showcase-map.mjs` afterwards only if you changed the importer.

## Step 4: Connect your own data (optional)

**If you have an Eventor account** (Swedish orienteering clubs):

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → **API key**
2. In Oxygen, go to **Settings** → paste the API key
3. Your real competitions, entries, and clubs will sync automatically

---

For local development setup, see the [README](../README.md).

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

You'll land on the Demo Competition — a fully populated, anonymized showcase derived from a real Swedish forest race: 5 classes, 169 runners across 38 clubs, a real OCAD map, completed runs with splits, 66 GPS tracks, and 2 700+ radio/finish punches. Everything is pre-wired so you can explore:

- **Runners / Start list / Results** — full field with classes, clubs, start times and splits
- **Courses** — controls and legs overlaid on the real map
- **Cards** — process SI card readouts against the existing field
- **Tracks & Replay** — GPS routes from the race, ready to scrub through
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

To regenerate the committed fixture from your own live Vinterserien data (regenerates `docs/screenshots/fixtures/showcase.sql` in place):

```bash
pnpm tsx scripts/anonymize-vinterserien.ts
```

This reads the `Vinterserien` event from your local PostgreSQL, pseudonymises runners, remaps card numbers, and writes a fresh portable SQL fixture. Override `SRC_NAME_ID` to point at a different source event.

## Step 4: Connect your own data (optional)

**If you have an Eventor account** (Swedish orienteering clubs):

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → **API key**
2. In Oxygen, go to **Settings** → paste the API key
3. Your real competitions, entries, and clubs will sync automatically

---

For local development setup, see the [README](../README.md).

# Try Oxygen in Cloud Shell

Oxygen is a lightweight orienteering competition management system. This tutorial gets you a fully working instance in about two minutes — no local setup needed.

## Step 1: Start the app with demo data

This script starts MySQL, initialises the database schema, loads the **Demo Competition** showcase, and starts the full app:

```bash
bash scripts/demo.sh
```

The first run takes a minute while Docker builds the images.

## Step 2: Open the app

Click **Web Preview** (the icon in the top-right of Cloud Shell) and select port **8080**.

You'll land on the Demo Competition — a fully populated, anonymized showcase derived from a real Swedish forest race: 5 classes, 169 runners across 38 clubs, a real OCAD map, completed runs with splits, 66 GPS tracks, and 2 700+ radio/finish punches. Everything is pre-wired so you can explore:

- **Runners / Start list / Results** — full field with classes, clubs, start times and splits
- **Courses** — controls and legs overlaid on the real map
- **Cards** — process SI card readouts against the existing field
- **Tracks & Replay** — GPS routes from the race, ready to scrub through
- **Kiosk** — open in a second tab for the self-service registration view

## Step 3: Load the showcase into another database (optional)

The showcase fixture lives in `docs/screenshots/fixtures/showcase.sql` and can be loaded into any MySQL instance with the standalone loader. Handy when you want a clean slate, or a second parallel DB to experiment in:

```bash
# Reload into the Cloud Shell docker MySQL
USE_DOCKER=1 FORCE=1 bash scripts/load-showcase.sh

# Load into a native MySQL on your host
pnpm showcase:load

# Load into a second DB name alongside the first
DB_NAME=demo2 bash scripts/load-showcase.sh
```

## Step 4: Connect your own data (optional)

**If you have an Eventor account** (Swedish orienteering clubs):

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → **API key**
2. In Oxygen, go to **Settings** → paste the API key
3. Your real competitions, entries, and clubs will sync automatically

---

For local development setup, see the [README](../README.md).

# Try Oxygen in Cloud Shell

Oxygen is a lightweight orienteering competition management system. This tutorial gets you a fully working instance in about two minutes — no local setup needed.

## Step 1: Start the app with demo data

This script starts MySQL, initialises the database schema, loads a sample competition, and starts the full app:

```bash
bash scripts/demo.sh
```

The first run takes a minute while Docker builds the images.

## Step 2: Open the app

Click **Web Preview** (the icon in the top-right of Cloud Shell) and select port **8080**.

You'll see a sample competition ready to explore. Try:

- **Runners** — entries with classes and clubs pre-loaded
- **Courses** — controls and legs for the sample event
- **Draw** — generate a start list
- **Cards** — process SI card readouts and see live results
- **Kiosk** — open in a second tab for the self-service registration view

## Step 3: Connect your own data (optional)

**If you have an Eventor account** (Swedish orienteering clubs):

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → **API key**
2. In Oxygen, go to **Settings** → paste the API key
3. Your real competitions, entries, and clubs will sync automatically

**To load a different seed dataset:**

```bash
docker compose exec -T mysql mysql -u meos itest < e2e/seed-vinterserien.sql
```

---

For local development setup, see the [README](../README.md).

# Try Oxygen in Cloud Shell

This tutorial walks you through running Oxygen — a lightweight orienteering management system — directly in Google Cloud Shell. You'll have a fully working instance running in your browser within a few minutes.

## Step 1: Install dependencies

Install pnpm and project dependencies:

```bash
npm install -g pnpm
pnpm install
```

## Step 2: Set up the database

Start a MySQL instance using Docker Compose:

```bash
docker compose up -d
```

Wait a few seconds for MySQL to be ready, then generate the Prisma client:

```bash
cp packages/api/.env.example packages/api/.env
pnpm db:generate
```

## Step 3: Start the application

```bash
pnpm dev
```

The API starts on port **3001** and the web app on port **5173**. In Cloud Shell, click the **Web Preview** button (top right) and select port 5173 to open the app.

## Step 4: Load data — Option A: Eventor API key

If you have access to the [Swedish Orienteering Federation's Eventor](https://eventor.orientering.se):

1. Log in to Eventor → your profile → **API key** — copy it
2. In Oxygen, go to **Settings** (gear icon) and paste your API key
3. Choose **Test-Eventor** or **Production** depending on your key
4. Navigate to **Competitions** — your upcoming events will appear
5. Select a competition to load its entries, classes, and clubs automatically

This is the fastest way to get real data in.

## Step 5: Load data — Option B: Demo seed data

No Eventor account? Load a sample competition from the included seed file:

```bash
# Load the test competition into the database
docker compose exec db mysql -u meos itest < e2e/seed-test-competition.sql
```

Refresh the app — a sample competition will appear in the competition selector.

## Step 6: Explore the app

Once a competition is loaded, here's what to try:

- **Dashboard** — overview of classes, runners, and status
- **Runners** → manage entries, assign classes and courses
- **Courses** → view course controls and legs (import from OCAD via the import button)
- **Draw** → generate a start list with automated time slots
- **Cards** → simulate SI card readout (or connect a real SI reader via Web Serial if your browser supports it)
- **Results** → live results update as cards are processed
- **Kiosk** → open in a second tab to see the self-service registration view

---

For full documentation and local development setup, see the [README](../README.md).

#!/usr/bin/env bash
# Sets up and starts Oxygen with demo data, suitable for Google Cloud Shell.
set -e

# ── 1. Start MySQL ───────────────────────────────────────────────────────────
echo "Starting MySQL..."
docker compose up -d mysql

echo "Waiting for MySQL to be ready..."
until docker compose exec mysql mysqladmin ping -h localhost --silent 2>/dev/null; do
  sleep 2
done

# ── 2. Create databases and apply schema ─────────────────────────────────────
echo "Initialising databases..."
docker compose exec mysql mysql -u meos -e \
  "CREATE DATABASE IF NOT EXISTS itest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE IF NOT EXISTS MeOSMain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

docker compose exec -T mysql mysql -u meos itest \
  < packages/api/prisma/meos-schema.sql

# ── 3. Load demo competition data ────────────────────────────────────────────
echo "Loading demo data..."
docker compose exec -T mysql mysql -u meos itest \
  < e2e/seed-test-competition.sql

# ── 4. Start API and web ─────────────────────────────────────────────────────
echo "Building and starting Oxygen (this takes a minute on first run)..."
docker compose up -d

echo ""
echo "✓ Oxygen is running!"
echo "  Open Web Preview on port 8080 to access the app."

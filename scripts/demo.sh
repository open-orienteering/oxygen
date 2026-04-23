#!/usr/bin/env bash
# Sets up and starts Oxygen with demo data, suitable for Google Cloud Shell.
set -e

# ── 1. Start MySQL ───────────────────────────────────────────────────────────
echo "Starting MySQL..."
docker compose up -d mysql

echo "Waiting for MySQL to accept connections..."
until docker compose exec mysql mysql -u root -e "SELECT 1" >/dev/null 2>&1; do
  sleep 2
done
echo "  MySQL is ready."

# ── 2. Create MeOSMain + MySQL user ──────────────────────────────────────────
# The Demo Competition database itself is created by the loader in step 3.
echo "Initialising MeOSMain and user..."
docker compose exec mysql mysql -u root -e \
  "CREATE DATABASE IF NOT EXISTS MeOSMain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER IF NOT EXISTS 'meos'@'%' IDENTIFIED BY '';
   GRANT ALL PRIVILEGES ON \`%\`.* TO 'meos'@'%';
   FLUSH PRIVILEGES;"
echo "  MeOSMain and user created."

echo "  Applying MeOSMain schema..."
docker compose exec -T mysql mysql -u root MeOSMain \
  < packages/api/prisma/meos-schema.sql

# ── 3. Load Demo Competition showcase ────────────────────────────────────────
echo "Loading Demo Competition showcase..."
USE_DOCKER=1 DB_NAME=demo_competition bash scripts/load-showcase.sh

# ── 4. Start API and web ─────────────────────────────────────────────────────
echo "Building and starting Oxygen (this takes a minute on first run)..."
docker compose up -d

echo ""
echo "✓ Oxygen is running!"
echo "  Open Web Preview on port 8080 to access the app."

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

# ── 2. Create databases, user, and apply schema ──────────────────────────────
echo "Initialising databases..."
docker compose exec mysql mysql -u root -e \
  "CREATE DATABASE IF NOT EXISTS itest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE IF NOT EXISTS MeOSMain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER IF NOT EXISTS 'meos'@'%' IDENTIFIED BY '';
   GRANT ALL PRIVILEGES ON \`%\`.* TO 'meos'@'%';
   FLUSH PRIVILEGES;"
echo "  Databases and user created."

echo "  Applying MeOSMain schema..."
docker compose exec -T mysql mysql -u root MeOSMain \
  < packages/api/prisma/meos-schema.sql

# ── 3. Load demo competition data ────────────────────────────────────────────
echo "Loading demo data..."
docker compose exec -T mysql mysql -u root itest \
  < e2e/seed-test-competition.sql
echo "  Seed loaded."

echo "  Registering competition..."
docker compose exec mysql mysql -u root MeOSMain -e \
  "INSERT INTO oEvent (Id, Name, Date, NameId, Annotation, Removed) VALUES (1, 'itest', '2025-01-01', 'itest', '', 0)
   ON DUPLICATE KEY UPDATE Name=VALUES(Name);"

# ── 4. Start API and web ─────────────────────────────────────────────────────
echo "Building and starting Oxygen (this takes a minute on first run)..."
docker compose up -d

echo ""
echo "✓ Oxygen is running!"
echo "  Open Web Preview on port 8080 to access the app."

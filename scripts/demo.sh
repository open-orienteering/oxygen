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
# Extra wait for init scripts to finish on first run
sleep 3

# ── 2. Create databases, user, and apply schema ──────────────────────────────
echo "Initialising databases..."
docker compose exec mysql mysql -u root -e \
  "CREATE DATABASE IF NOT EXISTS itest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE IF NOT EXISTS MeOSMain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER IF NOT EXISTS 'meos'@'%' IDENTIFIED BY '';
   GRANT ALL PRIVILEGES ON \`%\`.* TO 'meos'@'%';
   FLUSH PRIVILEGES;"

echo "  Applying MeOSMain schema..."
docker compose exec -T mysql mysql -u root MeOSMain \
  < packages/api/prisma/meos-schema.sql

# ── 3. Load demo competition data ────────────────────────────────────────────
echo "Loading demo data..."
if ! docker compose exec -T mysql mysql -u root --net-buffer-length=16384 itest \
  < e2e/seed-test-competition.sql 2>&1; then
  echo "  Seed failed — MySQL may have run out of memory. Retrying..."
  sleep 5
  # Verify MySQL is still running
  until docker compose exec mysql mysqladmin ping -h localhost --silent 2>/dev/null; do
    echo "  Waiting for MySQL to recover..."
    sleep 3
  done
  docker compose exec -T mysql mysql -u root --net-buffer-length=16384 itest \
    < e2e/seed-test-competition.sql
fi

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

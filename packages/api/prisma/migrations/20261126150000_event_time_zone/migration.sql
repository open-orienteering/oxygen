-- Package 8 (RES-06): the event's own IANA time zone. Time of day ("now",
-- has-started, station clocks, entry stamps) is computed in this zone, not in
-- the server process's zone (UTC in the Docker and Cloud Run images).
-- Additive with a default, so the previous image keeps working.
ALTER TABLE "oxygen"."events"
  ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'Europe/Stockholm';

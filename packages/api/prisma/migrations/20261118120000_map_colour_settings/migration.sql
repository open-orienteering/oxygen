-- A map's colour settings (slice I, row I6; docs/map-symbols.md §9.3,
-- docs/map-storage.md §2): the order its document is drawn in — the IOF
-- colour layers or the map's own table (answer 1) — and its per-deviation
-- overrides (answer 2; written by row I7). One row per club map series
-- (kept across its versions) or per event and source file (an event's own
-- upload, or its copy of a club map). Every import of the map reads it, and
-- the import job snapshots it like `decisions` and `patch`, so a re-claimed
-- job builds the same document.
--
-- Additive: a new table an older image never reads, and a job column with a
-- default an older image never writes (its jobs get `{}`, the defaults,
-- which is what it builds anyway).
CREATE TABLE "oxygen"."map_colour_settings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "club_map_id" UUID,
    "event_id" BIGINT,
    "source_hash" TEXT,
    -- 'iof' (the default) or 'source' (the map's own order, §9.2).
    "colour_order" TEXT NOT NULL DEFAULT 'iof',
    -- Record keyed by deviation key ("upper>lower") → 'keep' | 'drop'; only
    -- choices that differ from the default (KEPT_BY_DEFAULT), so a reset is
    -- removing a key. Kept while the order is 'source'.
    "deviations" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_colour_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "map_colour_settings_club_map_id_fkey"
      FOREIGN KEY ("club_map_id") REFERENCES "oxygen"."club_maps"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_colour_settings_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_colour_settings_source_hash_fkey"
      FOREIGN KEY ("source_hash") REFERENCES "oxygen"."map_sources"("file_hash")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_colour_settings_updated_by_fkey"
      FOREIGN KEY ("updated_by") REFERENCES "oxygen"."users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE,
    -- Exactly one target: a club map series, or an event's source file.
    CONSTRAINT "map_colour_settings_target_check" CHECK (
      ("club_map_id" IS NOT NULL AND "event_id" IS NULL AND "source_hash" IS NULL)
      OR ("club_map_id" IS NULL AND "event_id" IS NOT NULL AND "source_hash" IS NOT NULL)
    ),
    CONSTRAINT "map_colour_settings_order_check" CHECK ("colour_order" IN ('iof', 'source')),
    CONSTRAINT "map_colour_settings_deviations_check" CHECK (jsonb_typeof("deviations") = 'object')
);

CREATE UNIQUE INDEX "map_colour_settings_club_map_id_key"
  ON "oxygen"."map_colour_settings"("club_map_id");
CREATE UNIQUE INDEX "map_colour_settings_event_id_source_hash_key"
  ON "oxygen"."map_colour_settings"("event_id", "source_hash");
CREATE INDEX "map_colour_settings_source_hash_idx"
  ON "oxygen"."map_colour_settings"("source_hash");

-- The job's snapshot of the setting it imports with: `{ order, deviations }`;
-- `{}` = the defaults (and every row an older image inserts).
ALTER TABLE "oxygen"."map_import_jobs"
  ADD COLUMN "colour" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "oxygen"."map_import_jobs"
  ADD CONSTRAINT "map_import_jobs_colour_check" CHECK (jsonb_typeof("colour") = 'object');

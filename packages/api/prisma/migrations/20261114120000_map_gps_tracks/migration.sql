-- GPS tracks (slice G, row G24; docs/map-gps-tracks.md §1; slice G answer
-- 10). One row per track segment, per event, in WGS 84: the device parses
-- the GPX and the row's `points` are the shared `TrackPoints` columns
-- verbatim. Cloud-owned, not journaled, not in the checkout snapshot; in
-- the per-event dump. Additive: a new table an older image never reads.
CREATE TABLE "oxygen"."map_gps_tracks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    -- Track.name (§2.1); null when the GPX names none.
    "name" TEXT,
    -- The file the track came from; '' for an average.
    "source_name" TEXT NOT NULL DEFAULT '',
    -- TrackPoints { lat, lng, time, ele } (§2.1), columnar.
    "points" JSONB NOT NULL,
    -- Derived at write (user 2026-11-13): list answers without reading points.
    "point_count" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(3),
    -- The trim [start, end) on the stored points (§3.5); 0 / point_count untrimmed.
    "trim_start" INTEGER NOT NULL DEFAULT 0,
    "trim_end" INTEGER NOT NULL,
    -- An average's passes (§4): provenance only, no FK.
    "derived_from" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    -- An average's single-pass ranges (§4.1), [{start, end}] point indices.
    "single_pass" JSONB,
    -- The patch add op the track was converted into (G26).
    "converted_op" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Token (course-layer.md §7): an HLC minted on every write, as map_patches.
    "version" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "map_gps_tracks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "map_gps_tracks_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_gps_tracks_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "oxygen"."users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "map_gps_tracks_points_check" CHECK (jsonb_typeof("points") = 'object'),
    CONSTRAINT "map_gps_tracks_single_pass_check"
      CHECK ("single_pass" IS NULL OR jsonb_typeof("single_pass") = 'array'),
    CONSTRAINT "map_gps_tracks_trim_check"
      CHECK ("trim_start" >= 0 AND "trim_end" - "trim_start" >= 2 AND "trim_end" <= "point_count")
);

-- The list order.
CREATE INDEX "map_gps_tracks_event_id_created_at_id_idx"
  ON "oxygen"."map_gps_tracks"("event_id", "created_at", "id");

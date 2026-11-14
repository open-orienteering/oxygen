-- DEM fetch jobs (slice H, row H10; docs/map-storage.md §4.7; docs/map-terrain.md §7).
-- One row per (document, provider and resolution, terrain version): the
-- background fetch of a DEM for the document and the derive of its two
-- map_heightfields rows ('ground.<provider>', 'contours.<provider>'). The row
-- is the job's state, so any instance can report it and a stale one is
-- re-claimed; its failure states survive a restart. Cascades with its
-- document; the GC's version pass removes rows of a superseded terrain
-- version. Not carried by the checkout snapshot or the per-event dump.
-- Additive: a new table an older image never reads.
CREATE TABLE "oxygen"."map_dem_jobs" (
    "document_hash" TEXT NOT NULL,
    -- Provider id and resolution, e.g. 'lantmateriet-2m', 'glo30-30m'.
    "provider" TEXT NOT NULL,
    -- TERRAIN_VERSION (map-terrain.md §5.5).
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    -- unavailable: no-georeference | no-coverage | no-contours | over-cap | misaligned;
    -- failed: auth | http | format | timeout | derive.
    "reason" TEXT,
    -- The failure's message, capped; never a credential.
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- A failed job is retried from this time; NULL = not again.
    "next_attempt_at" TIMESTAMPTZ(6),
    "claimed_by" TEXT,
    "heartbeat_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_dem_jobs_pkey" PRIMARY KEY ("document_hash", "provider", "version"),
    CONSTRAINT "map_dem_jobs_document_hash_fkey"
      FOREIGN KEY ("document_hash") REFERENCES "oxygen"."map_documents"("hash")
      ON DELETE CASCADE,
    CONSTRAINT "map_dem_jobs_state_check" CHECK ("state" IN ('queued', 'running', 'done', 'unavailable', 'failed')),
    CONSTRAINT "map_dem_jobs_reason_check" CHECK (
      ("state" IN ('unavailable', 'failed')) = ("reason" IS NOT NULL)
    ),
    CONSTRAINT "map_dem_jobs_error_check" CHECK ("error" IS NULL OR length("error") <= 2000)
);

-- The engine's scan: runnable jobs by time.
CREATE INDEX "map_dem_jobs_runnable_idx" ON "oxygen"."map_dem_jobs" ("state", "next_attempt_at");

-- Chunked upload staging and import jobs (docs/map-storage.md §5–§6;
-- research 07 §4.4, §7, §8). Both are housekeeping tables: an upload is
-- gone once finalised into map_sources, a job row is the durable record
-- of one import so any API instance can report or resume it.

CREATE TABLE "oxygen"."map_uploads" (
  "id"             UUID PRIMARY KEY DEFAULT uuidv7(),
  "event_id"       BIGINT REFERENCES "oxygen"."events"("id") ON DELETE CASCADE,
  "file_name"      TEXT NOT NULL,
  "kind"           TEXT,
  "declared_bytes" INTEGER NOT NULL,
  "chunk_bytes"    INTEGER NOT NULL,
  "uploaded_by"    UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finalised_hash" TEXT REFERENCES "oxygen"."map_sources"("file_hash") ON DELETE SET NULL
);
CREATE INDEX "map_uploads_created_at_idx" ON "oxygen"."map_uploads"("created_at");

CREATE TABLE "oxygen"."map_upload_chunks" (
  "upload_id" UUID NOT NULL REFERENCES "oxygen"."map_uploads"("id") ON DELETE CASCADE,
  "n"         INTEGER NOT NULL,
  "bytes"     BYTEA NOT NULL,
  PRIMARY KEY ("upload_id", "n")
);
ALTER TABLE "oxygen"."map_upload_chunks" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

CREATE TABLE "oxygen"."map_import_jobs" (
  "id"            UUID PRIMARY KEY DEFAULT uuidv7(),
  "event_id"      BIGINT REFERENCES "oxygen"."events"("id") ON DELETE CASCADE,
  "club_map_id"   UUID REFERENCES "oxygen"."club_maps"("id") ON DELETE CASCADE,
  "source_hash"   TEXT NOT NULL REFERENCES "oxygen"."map_sources"("file_hash") ON DELETE CASCADE,
  "decisions"     JSONB NOT NULL DEFAULT '[]',
  "state"         TEXT NOT NULL,
  "stage"         TEXT,
  "progress"      REAL NOT NULL DEFAULT 0,
  "claimed_by"    TEXT,
  "heartbeat_at"  TIMESTAMPTZ(6),
  "document_hash" TEXT REFERENCES "oxygen"."map_documents"("hash") ON DELETE SET NULL,
  "error"         TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "map_import_jobs_state_heartbeat_idx" ON "oxygen"."map_import_jobs"("state", "heartbeat_at");
CREATE INDEX "map_import_jobs_event_id_created_at_idx" ON "oxygen"."map_import_jobs"("event_id", "created_at");
CREATE INDEX "map_import_jobs_club_map_id_created_at_idx" ON "oxygen"."map_import_jobs"("club_map_id", "created_at");
CREATE INDEX "map_import_jobs_source_hash_idx" ON "oxygen"."map_import_jobs"("source_hash");

-- Dual-write link: the legacy club library row and the series it mirrors.
ALTER TABLE "oxygen"."club_map_files"
  ADD COLUMN "club_map_id" UUID REFERENCES "oxygen"."club_maps"("id") ON DELETE SET NULL;
CREATE INDEX "club_map_files_club_map_id_idx" ON "oxygen"."club_map_files"("club_map_id");

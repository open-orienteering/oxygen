-- Content-addressed map storage (docs/map-storage.md; research 07 §4.1–4.2).
-- Sources and documents are immutable blobs keyed by SHA-256; references
-- use ON DELETE RESTRICT so only the GC job can remove a blob, never a
-- cascade. Blob columns are STORAGE EXTERNAL (uncompressed, out of line)
-- so range reads via substring() touch only the covering TOAST chunks.

CREATE TABLE "oxygen"."map_sources" (
  "file_hash"   TEXT PRIMARY KEY,
  "kind"        TEXT NOT NULL,
  "bytes"       BYTEA NOT NULL,
  "size_bytes"  INTEGER NOT NULL,
  "file_name"   TEXT NOT NULL,
  "uploaded_by" UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
ALTER TABLE "oxygen"."map_sources" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

CREATE TABLE "oxygen"."map_documents" (
  "hash"               TEXT PRIMARY KEY,
  "bytes"              BYTEA NOT NULL,
  "size_bytes"         INTEGER NOT NULL,
  "format_version"     INTEGER NOT NULL,
  "importer_version"   TEXT NOT NULL,
  "library_version"    TEXT NOT NULL,
  "source_hash"        TEXT NOT NULL REFERENCES "oxygen"."map_sources"("file_hash") ON DELETE RESTRICT,
  "header"             JSONB NOT NULL,
  "report"             JSONB NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_referenced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
ALTER TABLE "oxygen"."map_documents" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
CREATE INDEX "map_documents_source_hash_idx" ON "oxygen"."map_documents"("source_hash");

-- Derived rasters (thumbnails, symbol previews). Pure cache: cascades.
CREATE TABLE "oxygen"."map_previews" (
  "document_hash" TEXT NOT NULL REFERENCES "oxygen"."map_documents"("hash") ON DELETE CASCADE,
  "kind"          TEXT NOT NULL,
  "key"           TEXT NOT NULL DEFAULT '',
  "png"           BYTEA NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_hash", "kind", "key")
);

-- Club map series: settings about the map, not the file.
CREATE TABLE "oxygen"."club_maps" (
  "id"                  UUID PRIMARY KEY DEFAULT uuidv7(),
  "name"                TEXT NOT NULL,
  "colour_profile"      TEXT NOT NULL DEFAULT 'auto',
  "colour_overrides"    JSONB NOT NULL DEFAULT '{}',
  "north_lines_below"   BOOLEAN NOT NULL DEFAULT true,
  "rotation_correction" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "created_by"          UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE "oxygen"."club_map_versions" (
  "id"            UUID PRIMARY KEY DEFAULT uuidv7(),
  "club_map_id"   UUID NOT NULL REFERENCES "oxygen"."club_maps"("id") ON DELETE CASCADE,
  "seq"           INTEGER NOT NULL,
  "label"         TEXT NOT NULL DEFAULT '',
  "source_hash"   TEXT NOT NULL REFERENCES "oxygen"."map_sources"("file_hash") ON DELETE RESTRICT,
  "document_hash" TEXT NOT NULL REFERENCES "oxygen"."map_documents"("hash") ON DELETE RESTRICT,
  "uploaded_by"   UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL,
  "uploaded_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("club_map_id", "seq")
);
CREATE INDEX "club_map_versions_document_hash_idx" ON "oxygen"."club_map_versions"("document_hash");

-- Event map pins. file_data stays for one release (tile renderer, backups).
ALTER TABLE "oxygen"."map_files"
  ADD COLUMN "source_hash"         TEXT REFERENCES "oxygen"."map_sources"("file_hash") ON DELETE RESTRICT,
  ADD COLUMN "document_hash"       TEXT REFERENCES "oxygen"."map_documents"("hash") ON DELETE RESTRICT,
  ADD COLUMN "club_map_version_id" UUID REFERENCES "oxygen"."club_map_versions"("id") ON DELETE SET NULL;
CREATE INDEX "map_files_document_hash_idx" ON "oxygen"."map_files"("document_hash");

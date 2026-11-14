-- Height fields (slice H, row H4; docs/map-storage.md §4.7; research 10 §4).
-- The terrain a document's contours imply, derived at import stage 10 or on
-- the first request: cache keyed by (document, source, terrain version),
-- written once and never updated, cascading with its document. Not a GC
-- reference and not carried by the checkout snapshot or the per-event dump.
-- Additive: a new table an older image never reads.
CREATE TABLE "oxygen"."map_heightfields" (
    "document_hash" TEXT NOT NULL,
    -- 'contours' (map-terrain.md §5.5); free text so a DEM-based source (H10)
    -- needs no migration.
    "source" TEXT NOT NULL,
    -- TERRAIN_VERSION (map-terrain.md §5.5); the container version is in the bytes.
    "version" INTEGER NOT NULL,
    -- encodeHeightField(field), uncompressed; NULL when the document has no
    -- contours (the row then only records that, map-storage.md §4.7).
    "bytes" BYTEA,
    "size_bytes" INTEGER,
    -- The field's HeightFieldHeader and the TerrainReport, camelCase.
    "header" JSONB,
    "report" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_heightfields_pkey" PRIMARY KEY ("document_hash", "source", "version"),
    CONSTRAINT "map_heightfields_document_hash_fkey"
      FOREIGN KEY ("document_hash") REFERENCES "oxygen"."map_documents"("hash")
      ON DELETE CASCADE,
    CONSTRAINT "map_heightfields_field_check" CHECK (
      ("bytes" IS NULL) = ("size_bytes" IS NULL)
      AND ("bytes" IS NULL) = ("header" IS NULL)
      AND ("bytes" IS NULL) = ("report" IS NULL)
    )
);

-- Compact binary that gains little from pglz; out of line like the blobs.
ALTER TABLE "oxygen"."map_heightfields" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

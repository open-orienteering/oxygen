-- Club-wide OCAD base-map library (copied into events on use).

CREATE TABLE "oxygen"."club_map_files" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_data" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "scale" DOUBLE PRECISION,
    "bounds" JSONB,
    "north_offset" DOUBLE PRECISION,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "club_map_files_pkey" PRIMARY KEY ("id")
);

CREATE TRIGGER trg_club_map_files_updated_at BEFORE UPDATE ON oxygen.club_map_files
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

ALTER TABLE "oxygen"."club_map_files"
  ADD CONSTRAINT "club_map_files_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "oxygen"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Storage housekeeping (docs/map-storage.md §4.2, §8; research 07 §5–6).
-- `started_by` names the user whose request started an import job, for
-- the document route's "own import job" clause. Nullable: the backfill
-- and rows written before this migration have no starter. The index
-- serves that clause and the GC's NOT EXISTS over job references.

ALTER TABLE "oxygen"."map_import_jobs"
  ADD COLUMN "started_by" UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL;
CREATE INDEX "map_import_jobs_document_hash_idx" ON "oxygen"."map_import_jobs"("document_hash");

-- Promote (slice G, row G12a; docs/map-patches.md §5). A club map version
-- may carry corrections promoted from an event: an ordered list of
-- immutable layers the import bakes into the document at the store stage
-- (answers 2–3). The import job snapshots that list like `decisions`, and
-- the stored document records the list it was built with (answer 1), so
-- every re-import re-applies it and dedup tells two versions of one source
-- apart. Additive: columns with defaults (or nullable); an older image
-- neither reads nor writes them.
ALTER TABLE "oxygen"."club_map_versions"
  ADD COLUMN "patch" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "oxygen"."club_map_versions"
  ADD CONSTRAINT "club_map_versions_patch_check" CHECK (jsonb_typeof("patch") = 'array');

ALTER TABLE "oxygen"."map_import_jobs"
  ADD COLUMN "patch" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "oxygen"."map_import_jobs"
  ADD CONSTRAINT "map_import_jobs_patch_check" CHECK (jsonb_typeof("patch") = 'array');

-- NULL for a document built without corrections; never an empty array.
ALTER TABLE "oxygen"."map_documents"
  ADD COLUMN "patch" JSONB;
ALTER TABLE "oxygen"."map_documents"
  ADD CONSTRAINT "map_documents_patch_check" CHECK ("patch" IS NULL OR (jsonb_typeof("patch") = 'array' AND jsonb_array_length("patch") > 0));

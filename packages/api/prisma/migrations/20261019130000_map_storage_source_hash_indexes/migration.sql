-- Storage housekeeping (docs/map-storage.md §4.4, §8): the GC's source
-- pass and the source route probe these columns by hash.

CREATE INDEX "map_files_source_hash_idx" ON "oxygen"."map_files"("source_hash");
CREATE INDEX "club_map_versions_source_hash_idx" ON "oxygen"."club_map_versions"("source_hash");

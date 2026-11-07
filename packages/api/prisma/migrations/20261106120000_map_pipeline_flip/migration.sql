-- E3, the flip (docs/map-pipeline-switch.md, history note).
-- Every event reads through the vector pipeline; the per-event switch and
-- its three instance flags are gone from the code. The column and its enum
-- stay until E5 (v0.6.1) so `./deploy.sh v0.5.0` remains a working
-- rollback: that image reads `vector` for every event, and new events
-- written by this image get `vector` from the column default.
UPDATE "oxygen"."events" SET "map_pipeline" = 'vector' WHERE "map_pipeline" <> 'vector';

ALTER TABLE "oxygen"."events" ALTER COLUMN "map_pipeline" SET DEFAULT 'vector';

DELETE FROM "oxygen"."settings"
 WHERE "key" IN ('map.pipeline.default', 'map.pipeline.allowLegacy', 'map.editor.vector');

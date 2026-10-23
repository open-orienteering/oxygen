-- Per-event map pipeline switch (docs/map-pipeline-switch.md §2).
-- Gates which pipeline the event *reads* through: `legacy` (tiles) or
-- `vector` (map documents). Additive: existing events become `legacy`,
-- an older image ignores the column. New events take the instance
-- setting `map.pipeline.default` at creation (the API sets it; the
-- column default only covers rows written without it).
CREATE TYPE "oxygen"."map_pipeline" AS ENUM ('legacy', 'vector');

ALTER TABLE "oxygen"."events"
  ADD COLUMN IF NOT EXISTS "map_pipeline" "oxygen"."map_pipeline" NOT NULL DEFAULT 'legacy';

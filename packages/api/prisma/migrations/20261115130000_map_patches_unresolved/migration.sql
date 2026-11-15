-- Unresolved map patch ops (slice G, row G11; docs/map-patches.md §4.1).
-- When an event's pin moves, the ops that cannot follow their objects
-- leave `ops` for this record, keyed `<origin hash, 16 hex>:<op id>`, with
-- the anchors re-resolution retries them by. Additive: a column with a
-- default; an older image neither reads nor writes it.
ALTER TABLE "oxygen"."map_patches"
  ADD COLUMN "unresolved" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "oxygen"."map_patches"
  ADD CONSTRAINT "map_patches_unresolved_check" CHECK (jsonb_typeof("unresolved") = 'object');

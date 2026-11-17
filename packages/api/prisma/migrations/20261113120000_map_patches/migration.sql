-- Map patches (slice G, row G3; docs/map-patches.md §3; research 08 §4.7,
-- §4.8). An event's corrections to its pinned map document: keyed-state ops
-- merged on the server per op id (course-layer.md §7). One row per event,
-- cloud-owned, not journaled; it travels in the checkout snapshot and the
-- per-event dump. Additive: a new table an older image never reads.
CREATE TABLE "oxygen"."map_patches" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    -- The document the ops are keyed onto (map-patches.md §1). RESTRICT: the
    -- storage GC counts the row as a reference (map-storage.md §8.1).
    "document_hash" TEXT NOT NULL,
    -- The toggle (map-patches.md §1.4; 09 §6): false = draw the pinned document.
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    -- Record keyed by op id (map-patches.md §1.1–1.2).
    "ops" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Record keyed by the library entry id a symbol was materialised from (§1.3).
    "symbols" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Token (course-layer.md §7): an HLC minted on every write, as course_objects.
    "version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_patches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "map_patches_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_patches_document_hash_fkey"
      FOREIGN KEY ("document_hash") REFERENCES "oxygen"."map_documents"("hash")
      ON DELETE RESTRICT,
    CONSTRAINT "map_patches_ops_check" CHECK (jsonb_typeof("ops") = 'object'),
    CONSTRAINT "map_patches_symbols_check" CHECK (jsonb_typeof("symbols") = 'object')
);

-- One patch per event (slice G answer 1).
CREATE UNIQUE INDEX "map_patches_event_id_key"
  ON "oxygen"."map_patches"("event_id");
-- The GC's reference check and touch pass.
CREATE INDEX "map_patches_document_hash_idx"
  ON "oxygen"."map_patches"("document_hash");

CREATE TRIGGER trg_map_patches_updated_at
  BEFORE UPDATE ON "oxygen"."map_patches"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();

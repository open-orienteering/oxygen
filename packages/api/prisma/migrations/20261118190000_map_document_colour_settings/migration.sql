-- The colour settings known to give a stored document (slice I, row I7;
-- docs/map-symbols.md §9.3 "Overrides (row I7)", docs/map-storage.md §2,
-- §6.9). A document's report is written once, by its first import, so an
-- override that changes no bytes (a deviation the palette already keeps by
-- implication) gives the same hash with a report that still says "by
-- default"; judged from the report alone, such a map's pin was stale for
-- `colour` on every re-match and dedup never hit. Every finished import job
-- records the setting it imported with here, and a document follows a
-- setting when its report says so or a row here does.
--
-- Cache-like: a lost row costs one re-import, which writes it again. Not a
-- GC reference, not in the dump or the checkout snapshot. Additive: a new
-- table an older image never reads or writes.
CREATE TABLE "oxygen"."map_document_colour_settings" (
    "document_hash" TEXT NOT NULL,
    -- The normalised setting as canonical JSON (keys sorted, only choices
    -- that differ from the default): the row's identity.
    "colour_key" TEXT NOT NULL,
    -- The same setting as an object `{ order, deviations }`.
    "colour" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_document_colour_settings_pkey" PRIMARY KEY ("document_hash", "colour_key"),
    CONSTRAINT "map_document_colour_settings_document_hash_fkey"
      FOREIGN KEY ("document_hash") REFERENCES "oxygen"."map_documents"("hash")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_document_colour_settings_colour_check" CHECK (jsonb_typeof("colour") = 'object')
);

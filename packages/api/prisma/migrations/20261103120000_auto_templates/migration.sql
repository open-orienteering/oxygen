-- Auto templates, class print overrides, sheet keys and version tokens
-- (slice D, row D8; docs/course-layout.md §5–§6, docs/course-maps.md "Data
-- model"; research 08 §4.4, §4.6, §4.8, 09 §5). Additive: nullable columns
-- or columns with defaults an older image never reads. No sheet is moved
-- or deleted.

-- Templates by key: `<paper>-<orientation>-<scale>` (custom paper names its
-- size, `custom210x297-…`); `templateAutoKey` in @oxygen/shared derives the
-- same string on every write.
ALTER TABLE "oxygen"."map_templates"
  ADD COLUMN IF NOT EXISTS "auto_key" TEXT,
  ADD COLUMN IF NOT EXISTS "is_extra" BOOLEAN NOT NULL DEFAULT false,
  -- Optimistic-concurrency token (course-layout.md §2): an HLC minted on
  -- every write; templates are not journaled.
  ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 0;

-- Sheets: section index (map exchange, phase 2 writes > 0), the class whose
-- override the sheet prints, free props (setter maps, phase 2).
ALTER TABLE "oxygen"."course_maps"
  ADD COLUMN IF NOT EXISTS "section_index" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "class_id" UUID,
  ADD COLUMN IF NOT EXISTS "props" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "oxygen"."course_maps"
  ADD CONSTRAINT "course_maps_class_id_fkey"
    FOREIGN KEY ("class_id") REFERENCES "oxygen"."classes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "course_maps_class_id_idx"
  ON "oxygen"."course_maps"("class_id");

-- A class may print its course at another scale or on another template.
ALTER TABLE "oxygen"."classes"
  ADD COLUMN IF NOT EXISTS "print_scale" INTEGER,
  ADD COLUMN IF NOT EXISTS "sheet_template_id" UUID;
ALTER TABLE "oxygen"."classes"
  ADD CONSTRAINT "classes_print_scale_check" CHECK ("print_scale" IS NULL OR "print_scale" > 0),
  ADD CONSTRAINT "classes_sheet_template_id_fkey"
    FOREIGN KEY ("sheet_template_id") REFERENCES "oxygen"."map_templates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (09 §5): every template gets its key …
UPDATE "oxygen"."map_templates"
SET "auto_key" =
  CASE WHEN "paper" = 'custom'
    THEN 'custom' || round(coalesce("paper_width_mm", 0))::bigint || 'x' || round(coalesce("paper_height_mm", 0))::bigint
    ELSE "paper"
  END || '-' || "orientation" || '-' || "print_scale"
WHERE "auto_key" IS NULL;

-- … and of several sharing a key, all but one are extra — decision (3)
-- (user 2026-10-31): the auto one has the most sheets, ties to the oldest.
-- Names are kept (no renames); the key is shown as a badge.
WITH ranked AS (
  SELECT t."id",
         row_number() OVER (
           PARTITION BY t."event_id", t."auto_key"
           ORDER BY (SELECT count(*) FROM "oxygen"."course_maps" m WHERE m."template_id" = t."id") DESC,
                    t."created_at" ASC, t."seq" ASC
         ) AS rank
  FROM "oxygen"."map_templates" t
)
UPDATE "oxygen"."map_templates" t
SET "is_extra" = (ranked.rank > 1)
FROM ranked
WHERE ranked."id" = t."id";

-- At most one auto template per key and event.
CREATE UNIQUE INDEX IF NOT EXISTS "map_templates_one_auto_per_key"
  ON "oxygen"."map_templates"("event_id", "auto_key")
  WHERE NOT "is_extra" AND "auto_key" IS NOT NULL;

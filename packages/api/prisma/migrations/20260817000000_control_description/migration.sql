-- Control descriptions belong to the control, not the course.
--
-- Until now, IOF control descriptions (parsed from OCAD 702000 objects at
-- import time) only existed as `description` properties on control Point
-- features inside `courses.geometry` JSONB. That duplicated them per
-- course and lost them whenever geometry was regenerated. This migration
-- adds a proper `controls.description` column and backfills it from the
-- existing course geometry.

ALTER TABLE "oxygen"."controls" ADD COLUMN "description" JSONB;

-- Backfill: for every event, take each control Point feature that carries
-- a description and copy it onto the control row whose first punch code
-- matches the feature's code. DISTINCT ON keeps one description per
-- (event, code) — the same control may appear in several courses with an
-- identical description.
UPDATE "oxygen"."controls" AS c
SET "description" = src.description
FROM (
  SELECT DISTINCT ON (co.event_id, f -> 'properties' ->> 'code')
    co.event_id,
    f -> 'properties' ->> 'code' AS code,
    f -> 'properties' -> 'description' AS description
  FROM "oxygen"."courses" AS co
  CROSS JOIN LATERAL jsonb_array_elements(co.geometry -> 'features') AS f
  WHERE co.geometry IS NOT NULL
    AND jsonb_typeof(co.geometry -> 'features') = 'array'
    AND f -> 'properties' ->> 'symbolType' = 'control'
    AND (f -> 'properties') ? 'description'
  ORDER BY co.event_id, f -> 'properties' ->> 'code', co.updated_at DESC
) AS src
WHERE c.event_id = src.event_id
  AND c.description IS NULL
  AND split_part(c.codes, ';', 1) = src.code;
